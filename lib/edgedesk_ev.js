/* ===========================================================================
   EDGEDESK EV INTELLIGENCE ENGINE — price-specific expected value research.
   docs/edgedesk-ev/DESIGN.md

   EV is not a model. It is arithmetic applied to a calibrated probability and
   an exact executable price:

       EV = Σ over settlement states [ P(state) × net payoff(state) ]

   This file turns what EdgeDesk already produces into that arithmetic, for
   every supported quote, and says honestly how much of it can be trusted.

     independent game price   the champion's frozen probability CURVE (stored by
                              football/cfb_terminal/build.js, read through
                              lib/edgedesk_read.js sideProb) — never re-derived
     calibrated probability   an out-of-sample calibrator that won the walk-
                              forward tournament (football/cfb_ev/tournament.js)
                              — football-only: the market never enters it
     exact price              the quote's own odds, normalised at full precision
     break-even               from the price and the settlement states (pushes)
     probability edge, EV     raw, calibrated, and robust (sampled) — never merged
     decision                 the pre-registered EV policy (docs/edgedesk-ev/
                              PREREG.md), capped by research status, freshness,
                              integrity, calibration maturity and promotion stage

   WHAT THIS FILE NEVER DOES
     - compute a football number (no margin, sigma or PMF is built here: the
       calibrated curve is the stored one, its own masses reweighted);
     - let a sportsbook price into EdgeDesk's probability (de-vigged market
       probabilities are a separate BENCHMARK field);
     - assume −110, assume a binary market, ignore a push, or fall back to 50%;
     - certify a bet the governed layers have not certified. While the EV
       policy is in SHADOW, a policy BET is recorded as such and shown to the
       reader as RESEARCH ONLY.

   ODDS MATH has one home: football/cfb_decision/decision.js (americanToPayout,
   payoutToAmerican, applyMap). The curve lookup has one home: EDRead.sideProb.

   CONVENTIONS (the Read's)
     side         'home' | 'away'
     book line    what a book prints for the side: +6.5 = the side gets 6.5
     home line    the line the HOME side lays (negative = home favoured)
     cover        P(side covers | no push)   — the conditional basis
     win / push / loss                       — the unconditional states
     edge         cover − 1/decimal          — the conditional (no-push) basis,
                  the basis of cfb_decision_policy_v1.min_probability_edge;
                  the unconditional pair (win vs (1−push)/decimal) is stored too

   Browser: window.EDEV (load decision.js and edgedesk_read.js first).
   Node: require('./edgedesk_ev.js'). ES5, no dependencies beyond those two.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDEV = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_ev_engine_v1';
  var SCHEMA = 'edgedesk_ev_snapshot_v1';
  var CAL_SCHEMA = 'edgedesk_ev_calibration_schema_v1';
  var POLICY_SCHEMA = 'edgedesk_ev_policy_schema_v1';

  var D = root && root.EDCfbDecision ? root.EDCfbDecision : null;
  if (!D && typeof require === 'function') { try { D = require('../football/cfb_decision/decision.js'); } catch (e) { D = null; } }
  var RD = root && root.EDRead ? root.EDRead : null;
  if (!RD && typeof require === 'function') { try { RD = require('./edgedesk_read.js'); } catch (e) { RD = null; } }
  function dec() { if (!D) throw new Error('EDEV needs EDCfbDecision (football/cfb_decision/decision.js) loaded first'); return D; }
  function rd() { if (!RD) throw new Error('EDEV needs EDRead (lib/edgedesk_read.js) loaded first'); return RD; }

  /* ------------------------------------------------------------- helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 6 : k); return Math.round(x * m) / m; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function pct(p, dp) { return isNum(p) ? (100 * p).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function ppText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function evText(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + '%' : '—'; }
  function pts(x) { return isNum(x) ? Math.abs(x).toFixed(1) + ' POINT' + (Math.abs(Math.abs(x) - 1) < 1e-9 ? '' : 'S') : '—'; }
  function lineText(v) { return rd().lineText(v); }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function isInt(x) { return isNum(x) && Math.abs(x - Math.round(x)) < 1e-9; }
  function halfPoint(x) { return isNum(x) && Math.abs(x * 2 - Math.round(x * 2)) < 1e-9; }
  function quarterPoint(x) { return isNum(x) && Math.abs(x * 4 - Math.round(x * 4)) < 1e-9 && !halfPoint(x); }
  function sortNum(a) { return a.filter(isNum).slice().sort(function (x, y) { return x - y; }); }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var h = (sorted.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
  }
  function mean(xs) { xs = xs.filter(isNum); return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null; }
  function logit(p) { p = clamp(p, 1e-4, 1 - 1e-4); return Math.log(p / (1 - p)); }
  function sigm(x) { return 1 / (1 + Math.exp(-x)); }
  /* FNV-1a 32 + a second mix: stable ids and seeds, browser and node alike */
  function hash(parts) {
    var s = typeof parts === 'string' ? parts : JSON.stringify(parts), h = 0x811c9dc5, h2 = 0x01000193, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }
  /* mulberry32: a deterministic sampler, so a read recomputes byte for byte */
  function prng(seed) {
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function normalDraws(rand, n) {
    var out = [], i, u, v;
    for (i = 0; i < n; i += 2) {
      u = rand() || 1e-12; v = rand();
      var m = Math.sqrt(-2 * Math.log(u));
      out.push(m * Math.cos(2 * Math.PI * v));
      if (i + 1 < n) out.push(m * Math.sin(2 * Math.PI * v));
    }
    return out;
  }

  /* =================================================================
     THE POLICY. Every number is pre-registered (docs/edgedesk-ev/PREREG.md
     §7) and versioned in football/cfb_ev/policy/cfb_ev_policy_v1.json; the
     defaults below are that file's values, so a page without the file still
     reads the same rules. A PRESENTATION value decides wording only.
     ================================================================= */
  var POLICY = {
    schema: POLICY_SCHEMA, version: 'cfb_ev_policy_v1', maturity: 'SHADOW',
    min_probability_edge: 0.01,          /* cfb_decision_policy_v1 (DEV plateau) */
    min_calibrated_ev: 0,                /* cfb_decision_policy_v1.min_ev */
    min_conservative_ev: 0,              /* declared: the 10th-percentile EV must not be negative */
    conservative_quantile: 0.10,         /* declared a priori, never tuned */
    interval: [0.05, 0.95],              /* declared */
    samples: 500,                        /* declared */
    max_price: -125,                     /* cfb_decision_policy_v1.max_price: a longer price is research, never actionable */
    reference_price: -110,               /* the price a line ladder is quoted at — a reference, never an assumption about a quote */
    ttl_minutes: { spread: 180, alternate_spread: 90, moneyline: 180, total: 180, user: 30, near_kickoff: 60, extreme: 60 },
    near_kickoff_hours: 6,
    juice: { min_pr: 0.80, ev_equivalent: 0.0005 },
    timing: { move_pts: 0.5, key_numbers: [3, 7, 10, 14], typical_move_pts: 1.9, min_gap_for_wait: 2 },
    extreme: { review_quantile: 0.95, severe_quantile: 0.99 },
    betting_enabled: false,
    require_calibration: ['PROMOTED', 'IDENTITY_VALIDATED'],
    staking: { enabled: false, baseline: 'flat 1u', challengers: ['capped fractional Kelly (≤ 0.25)', 'robust Kelly on the conservative probability'], note: 'downstream of validated EV; no Kelly default' }
  };
  function policyOf(P) {
    var o = copy(POLICY), k;
    if (P && typeof P === 'object') for (k in P) if (has(P, k) && P[k] != null) o[k] = (typeof P[k] === 'object' && !Array.isArray(P[k]) && o[k] && typeof o[k] === 'object') ? mergeObj(o[k], P[k]) : P[k];
    return o;
  }
  function mergeObj(a, b) { var o = copy(a), k; for (k in b) if (has(b, k)) o[k] = b[k]; return o; }

  /* the words: research words only (docs/edgedesk-ev/DESIGN.md §§55-56) */
  var DECISION = {
    BET_EARLY: 'The policy clears this exact, fresh quote on calibrated and robust EV, and a measured reason says the number may not last.',
    BET: 'The policy clears this exact, fresh quote on calibrated and robust EV. No measured reason to hurry.',
    WAIT: 'Not at this price: a named target price or a named piece of information would change the read. Never a forecast that the line will move.',
    PASS: 'The price does not clear the policy on calibrated and robust EV, and no reachable target exists.',
    PRICE_GONE: 'A previous quote cleared the policy; the current one does not. The frozen read stays as it was.',
    RESEARCH_ONLY: 'The EV is shown as research: the policy is in SHADOW, the calibration is experimental, the inputs are limited, or an extreme EV has not been verified.',
    NO_DECISION: 'Something required is missing, stale, unsupported or faulty. EdgeDesk does not guess.'
  };
  var TOOLTIP = 'EdgeDesk EV estimates the long-run return of this exact price using EdgeDesk’s calibrated probability. It is not a guarantee and can be wrong if the model probability is wrong.';
  var BANNED = [/\block\b/i, /\bhammer/i, /free money/i, /max bet/i, /max play/i, /guarantee/i, /can'?t lose/i, /sure thing/i, /risk[- ]?free/i,
    /sharp money/i, /smart money/i, /\bsteam\b/i, /wait for (the )?sharps/i, /🔥/];

  /* ================================================================ ODDS
     Every representation of a price is a payout, not a different EV concept
     (pack K25). Internally a price is its gross decimal and its net payout
     b = decimal − 1, at the source's full precision. A source that publishes
     only an implied percentage keeps that number as its break-even and is
     marked approximate; when raw odds exist they always win. */
  function validAmerican(a) { return isNum(a) && !(a > -100 && a < 100) && Math.abs(a) <= 100000; }
  function americanToDecimal(a) { if (!validAmerican(a)) return null; return 1 + dec().americanToPayout(a); }
  /* exact (unrounded): the American price a decimal represents */
  function decimalToAmerican(d) { if (!isNum(d) || !(d > 1)) return null; return d >= 2 ? 100 * (d - 1) : -100 / (d - 1); }
  function decimalToAmericanRounded(d) { var a = decimalToAmerican(d); if (!isNum(a)) return null; var x = Math.round(a); return x > -100 && x < 100 ? (x >= 0 ? 100 : -100) : x; }
  function fractionalToDecimal(s) {
    var t = String(s == null ? '' : s).trim().toLowerCase();
    if (/^ev(en)?s?$/.test(t)) return 2;
    var m = /^(\d+(?:\.\d+)?)\s*[\/-]\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) return null;
    var n = parseFloat(m[1]), d = parseFloat(m[2]);
    return d > 0 && n > 0 ? 1 + n / d : null;
  }
  function hongKongToDecimal(h) { return isNum(h) && h > 0 ? 1 + h : null; }
  function malayToDecimal(m) { if (!isNum(m) || m === 0 || m > 1 || m < -1) return null; return m > 0 ? 1 + m : 1 + 1 / Math.abs(m); }
  function indonesianToDecimal(i) { if (!isNum(i) || (i > -1 && i < 1)) return null; return i >= 1 ? 1 + i : 1 + 1 / Math.abs(i); }
  function impliedProbability(d) { return isNum(d) && d > 1 ? 1 / d : null; }
  /* normalizeOdds(x): a number is American; an object names its format; a string is parsed.
     Precedence when several are present: American, decimal, fractional, HK, Malay, Indonesian, implied %. */
  function normalizeOdds(x) {
    var out = { valid: false, format: null, american: null, american_display: null, decimal: null, net_payout: null, implied_raw: null,
      implied_source: null, precision: null, approximate_american: false, problem: null };
    if (typeof x === 'string') return parseOdds(x);
    var o = isNum(x) ? { american: x } : (x && typeof x === 'object' ? x : {});
    var d = null, a = num(o.american);
    if (a != null) {
      if (!validAmerican(a)) { out.problem = 'not an American price (' + a + ')'; return out; }
      d = americanToDecimal(a); out.format = 'AMERICAN'; out.american = a;
    } else if (num(o.decimal) != null) { d = num(o.decimal); out.format = 'DECIMAL'; }
    else if (o.fractional != null) { d = fractionalToDecimal(o.fractional); out.format = 'FRACTIONAL'; }
    else if (num(o.hk) != null) { d = hongKongToDecimal(num(o.hk)); out.format = 'HONG_KONG'; }
    else if (num(o.malay) != null) { d = malayToDecimal(num(o.malay)); out.format = 'MALAY'; }
    else if (num(o.indonesian) != null) { d = indonesianToDecimal(num(o.indonesian)); out.format = 'INDONESIAN'; }
    else if (num(o.implied) != null) {
      var p = num(o.implied); if (p > 1 && p < 100) p = p / 100;
      if (!(p > 0.005 && p < 0.995)) { out.problem = 'implied probability out of bounds (' + o.implied + ')'; return out; }
      d = 1 / p; out.format = 'IMPLIED_PERCENT'; out.implied_source = p;
    } else { out.problem = 'no price'; return out; }
    if (!isNum(d) || !(d > 1.0001) || d > 1001) { out.problem = 'price out of bounds (' + (o.decimal != null ? o.decimal : (o.fractional || o.hk || o.malay || o.indonesian || '?')) + ')'; return out; }
    out.decimal = d; out.net_payout = d - 1; out.implied_raw = 1 / d;
    if (out.american == null) { out.american = decimalToAmerican(d); out.approximate_american = out.format !== 'AMERICAN'; }
    out.american_display = out.format === 'AMERICAN' ? a : decimalToAmericanRounded(d);
    out.precision = 'SOURCE_' + out.format;
    out.valid = true;
    return out;
  }
  /* "-113", "+145", "1.91", "5/2", "evens", "53%", "HK 0.91" */
  function parseOdds(s) {
    var t = String(s || '').replace(/[()\s]/g, '').replace(/[−–—]/g, '-'), m;
    if ((m = /^(\d+(?:\.\d+)?)%$/.exec(t))) return normalizeOdds({ implied: parseFloat(m[1]) / 100 });
    if ((m = /^([+-]\d{3,6})$/.exec(t)) || (m = /^(\d{3,6})$/.exec(t))) return normalizeOdds(parseInt(m[1], 10));
    if ((m = /^(\d+(?:\.\d+)?\/\d+(?:\.\d+)?)$/.exec(t)) || /^evens?$/i.test(t)) return normalizeOdds({ fractional: m ? m[1] : t });
    if ((m = /^hk(\d+(?:\.\d+)?)$/i.exec(t))) return normalizeOdds({ hk: parseFloat(m[1]) });
    if ((m = /^(\d+\.\d+)$/.exec(t))) return normalizeOdds({ decimal: parseFloat(m[1]) });
    return normalizeOdds(null);
  }

  /* ========================================================= SETTLEMENT
     Every market type states its settlement states explicitly. A structure
     is ACTIVE only when its rules are implemented, tested AND EdgeDesk has a
     validated probability for it; CONTRACT_ONLY means the arithmetic is
     implemented and tested but no EdgeDesk probability exists (the engine
     refuses to decide on it); BLOCKED means the arithmetic itself would be a
     shortcut today (pack M10–M14). Nothing unsupported is approximated. */
  var STATE = { FULL_WIN: 'FULL_WIN', HALF_WIN: 'HALF_WIN', PUSH: 'PUSH', VOID: 'VOID', HALF_LOSS: 'HALF_LOSS', FULL_LOSS: 'FULL_LOSS' };
  var MARKETS = {
    spread: { id: 'M01', label: 'US point spread', status: 'ACTIVE', states: 'FULL_WIN / FULL_LOSS on a half point; FULL_WIN / PUSH / FULL_LOSS on an integer line', probability: 'the champion curve' },
    alternate_spread: { id: 'M03', label: 'Alternate spread', status: 'ACTIVE', states: 'as spread', probability: 'the same frozen curve at the alternate line', note: 'thin-market quotes carry a lower liquidity grade' },
    moneyline: { id: 'M02', label: 'US moneyline', status: 'RESEARCH', states: 'FULL_WIN / VOID / FULL_LOSS (a college football tie cannot happen: P(void) = 0 declared)', probability: 'the champion win probability', reason: 'moneyline is tier RESEARCH (football/validation/pricing_cfb.json): EV is research context, never a decision' },
    total: { id: 'M01', label: 'Total', status: 'NOT_ACTIVATED', states: 'FULL_WIN / PUSH / FULL_LOSS', reason: 'no total distribution curve is published for the champion; a total EV would need one' },
    team_total: { id: 'M01', label: 'Team total', status: 'NOT_ACTIVATED', reason: 'no team-total distribution is published' },
    euro_1x2: { id: 'M04', label: 'European 1X2', status: 'CONTRACT_ONLY', states: 'FULL_WIN / FULL_LOSS on one of three outcomes', reason: 'needs a three-way outcome model; none exists for EdgeDesk sports today' },
    asian_half: { id: 'M05', label: 'Asian handicap (half line)', status: 'CONTRACT_ONLY', states: 'FULL_WIN / FULL_LOSS', reason: 'no soccer distribution' },
    asian_whole: { id: 'M06', label: 'Asian handicap (whole line)', status: 'CONTRACT_ONLY', states: 'FULL_WIN / PUSH / FULL_LOSS', reason: 'no soccer distribution' },
    asian_quarter: { id: 'M07', label: 'Asian handicap (quarter line)', status: 'CONTRACT_ONLY', states: 'FULL_WIN / HALF_WIN / HALF_LOSS / FULL_LOSS (a split stake)', reason: 'no soccer distribution; the settlement is implemented (asianQuarterStates) and tested' },
    exchange_back: { id: 'M08', label: 'Exchange back', status: 'CONTRACT_ONLY', states: 'FULL_WIN (net of commission) / FULL_LOSS', reason: 'no exchange feed, no venue commission registry, no liquidity data' },
    exchange_lay: { id: 'M09', label: 'Exchange lay', status: 'CONTRACT_ONLY', states: 'per unit of LIABILITY: FULL_WIN (net of commission) / FULL_LOSS', reason: 'as exchange back' },
    pari_mutuel: { id: 'M10', label: 'Pari-mutuel', status: 'BLOCKED', reason: 'the final price is unknown until the pool closes; a fixed EV from a tote estimate would be fiction. A future module must model the final pool and self-impact' },
    live: { id: 'M11', label: 'Live / in-play', status: 'BLOCKED', reason: 'no synchronized game state, latency measurement, quote-timestamp guarantee, suspension handling or live model validation: fail closed' },
    sgp: { id: 'M12', label: 'Same-game parlay', status: 'BLOCKED', reason: 'correlated legs need a validated joint distribution; multiplying marginal probabilities is invalid' },
    futures: { id: 'M13', label: 'Futures', status: 'BLOCKED', reason: 'a separate horizon-calibrated module' },
    promo: { id: 'M14', label: 'Promos / boosts / free bets', status: 'BLOCKED', reason: 'a transformed payoff kept in its own ledger, never mixed with base model EV' }
  };
  function marketSupport(type) {
    var m = MARKETS[type];
    if (!m) return { type: type, status: 'UNSUPPORTED', decides: false, reason: 'unknown market structure "' + type + '"' };
    return { type: type, id: m.id, label: m.label, status: m.status, decides: m.status === 'ACTIVE', reason: m.reason || null, states: m.states || null };
  }
  function payoffOf(state, b, commission) {
    var c = isNum(commission) ? commission : 0;
    switch (state) {
      case STATE.FULL_WIN: return b * (1 - c);
      case STATE.HALF_WIN: return (b / 2) * (1 - c);
      case STATE.PUSH: case STATE.VOID: return 0;
      case STATE.HALF_LOSS: return -0.5;
      case STATE.FULL_LOSS: return -1;
      default: throw new Error('unknown settlement state ' + state);
    }
  }
  /* the universal formula: fails closed on probabilities that do not form a distribution */
  function expectedValue(states) {
    if (!states || !states.length) return null;
    var s = 0, ev = 0, i;
    for (i = 0; i < states.length; i++) {
      var x = states[i];
      if (!isNum(x.p) || x.p < -1e-12 || x.p > 1 + 1e-12 || !isNum(x.payoff)) return null;
      s += x.p; ev += x.p * x.payoff;
    }
    if (Math.abs(s - 1) > 1e-6) return null;
    return ev;
  }
  /* a fixed-odds two-way market: a half point cannot push; an integer line can; a moneyline can void */
  function twoWayStates(pWin, pPush, decimal, opts) {
    opts = opts || {};
    if (!isNum(pWin) || !isNum(decimal) || !(decimal > 1)) return null;
    var pu = isNum(pPush) ? pPush : 0, b = decimal - 1, loss = 1 - pWin - pu;
    if (loss < -1e-9 || pu < 0 || pWin < 0) return null;
    var out = [{ state: STATE.FULL_WIN, p: pWin, payoff: payoffOf(STATE.FULL_WIN, b, opts.commission) }];
    if (opts.allow_push || pu > 0) out.push({ state: opts.void ? STATE.VOID : STATE.PUSH, p: pu, payoff: 0 });
    out.push({ state: STATE.FULL_LOSS, p: Math.max(0, loss), payoff: -1 });
    return out;
  }
  /* Asian quarter handicap: the stake is split across line − ¼ and line + ¼.
     pmf(k) = P(the side's margin = k) for integer k (the whole distribution). */
  function asianQuarterStates(line, pmf, decimal, kRange) {
    if (!quarterPoint(line)) return null;
    var b = decimal - 1, a = line - 0.25, c = line + 0.25, acc = {}, lo = kRange ? kRange[0] : -100, hi = kRange ? kRange[1] : 100, k, tot = 0;
    [STATE.FULL_WIN, STATE.HALF_WIN, STATE.HALF_LOSS, STATE.FULL_LOSS].forEach(function (s) { acc[s] = 0; });
    function res(m, L) { var x = m + L; return x > 1e-9 ? 'W' : (x < -1e-9 ? 'L' : 'P'); }
    for (k = lo; k <= hi; k++) {
      var p = pmf(k); if (!isNum(p) || p <= 0) continue;
      tot += p;
      var r1 = res(k, a), r2 = res(k, c), key = r1 + r2;
      var st = key === 'WW' ? STATE.FULL_WIN : (key === 'PW' || key === 'WP' ? STATE.HALF_WIN : (key === 'LP' || key === 'PL' ? STATE.HALF_LOSS : (key === 'LL' ? STATE.FULL_LOSS : null)));
      if (!st) return null;                                           /* a quarter line never has W+L or P+P */
      acc[st] += p;
    }
    if (!(tot > 0)) return null;
    return [STATE.FULL_WIN, STATE.HALF_WIN, STATE.HALF_LOSS, STATE.FULL_LOSS].map(function (s) { return { state: s, p: acc[s] / tot, payoff: payoffOf(s, b) }; });
  }
  /* F19: EV from the four quarter-line state probabilities directly */
  function asianQuarterEv(pFW, pHW, pHL, pFL, decimal) {
    return expectedValue([{ state: STATE.FULL_WIN, p: pFW, payoff: decimal - 1 }, { state: STATE.HALF_WIN, p: pHW, payoff: (decimal - 1) / 2 },
      { state: STATE.HALF_LOSS, p: pHL, payoff: -0.5 }, { state: STATE.FULL_LOSS, p: pFL, payoff: -1 }]);
  }
  /* F20: exchange BACK — commission on net winnings */
  function exchangeBackStates(pWin, decimal, commission) {
    if (!isNum(commission) || commission < 0 || commission >= 1) return null;
    return twoWayStates(pWin, 0, decimal, { commission: commission });
  }
  /* exchange LAY, per unit of LIABILITY: laying at d risks (d − 1) × stake; the lay wins the backer's stake, net of commission */
  function exchangeLayStates(pSelectionWins, decimal, commission) {
    if (!isNum(pSelectionWins) || !(decimal > 1) || !isNum(commission) || commission < 0 || commission >= 1) return null;
    var winPerLiability = (1 - commission) / (decimal - 1);
    return [{ state: STATE.FULL_WIN, p: 1 - pSelectionWins, payoff: winPerLiability, basis: 'LIABILITY' }, { state: STATE.FULL_LOSS, p: pSelectionWins, payoff: -1, basis: 'LIABILITY' }];
  }
  /* F08 / F09: break-even for a two-way price with a modelled push */
  function breakEven(decimal, pPush) {
    if (!isNum(decimal) || !(decimal > 1)) return null;
    var pu = isNum(pPush) ? pPush : 0;
    return { conditional_nonpush: 1 / decimal, unconditional: (1 - pu) / decimal, push: pu };
  }
  /* F10: the decimal price at which a probability is exactly fair */
  function fairDecimal(pWin, pPush) { var pu = isNum(pPush) ? pPush : 0; return isNum(pWin) && pWin > 0 ? (1 - pu) / pWin : null; }
  function twoWayEv(pWin, pPush, decimal) { return expectedValue(twoWayStates(pWin, pPush, decimal, { allow_push: true })); }

  /* ====================================================== MARKET DE-VIG
     A BENCHMARK, never EdgeDesk's probability. n-way, from decimal prices.
     additive carries a validity guard; every method reports its overround. */
  function devig(decimals, method) {
    var q = (decimals || []).map(function (d) { return isNum(d) && d > 1 ? 1 / d : null; });
    if (q.length < 2 || q.some(function (x) { return x == null; })) return { ok: false, method: method, problem: 'every outcome needs a valid price' };
    var s = q.reduce(function (a, b) { return a + b; }, 0), n = q.length, p, z = null, k = null;
    var over = s - 1;
    if (over < -0.02 || over > 0.5) return { ok: false, method: method, overround: over, problem: 'overround ' + over.toFixed(4) + ' is outside a sane book (−2% to +50%)' };
    switch (method || 'proportional') {
      case 'proportional':
        p = q.map(function (x) { return x / s; }); break;
      case 'additive':
        p = q.map(function (x) { return x - over / n; });
        if (p.some(function (x) { return x <= 0 || x >= 1; })) return { ok: false, method: 'additive', overround: over, problem: 'additive de-vig produced an impossible probability (an extreme longshot): guard tripped' };
        break;
      case 'power': {
        if (Math.abs(over) < 1e-12) { p = q.slice(); k = 1; break; }
        var lo = 0.5, hi = 3, i;
        for (i = 0; i < 100; i++) { var mid = (lo + hi) / 2, t = q.reduce(function (a, x) { return a + Math.pow(x, mid); }, 0); if (t > 1) lo = mid; else hi = mid; }
        k = (lo + hi) / 2; p = q.map(function (x) { return Math.pow(x, k); });
        var ps = p.reduce(function (a, b) { return a + b; }, 0); p = p.map(function (x) { return x / ps; });
        break;
      }
      case 'shin': {
        /* Shin (1993) insider share z: p_i = (sqrt(z² + 4(1−z) q_i²/S) − z) / (2(1−z)), z solved so Σp = 1 */
        if (over <= 0) { p = q.map(function (x) { return x / s; }); z = 0; break; }
        var f = function (zz) { return q.reduce(function (a, x) { return a + (Math.sqrt(zz * zz + 4 * (1 - zz) * x * x / s) - zz) / (2 * (1 - zz)); }, 0) - 1; };
        var a2 = 0, b2 = 0.4, j;
        for (j = 0; j < 100; j++) { var m2 = (a2 + b2) / 2; if (f(m2) > 0) a2 = m2; else b2 = m2; }
        z = (a2 + b2) / 2;
        p = q.map(function (x) { return (Math.sqrt(z * z + 4 * (1 - z) * x * x / s) - z) / (2 * (1 - z)); });
        var ss = p.reduce(function (aa, bb) { return aa + bb; }, 0); p = p.map(function (x) { return x / ss; });
        break;
      }
      default: return { ok: false, method: method, problem: 'unknown de-vig method' };
    }
    return { ok: true, method: method || 'proportional', p: p, raw: q, overround: over, hold: 1 - 1 / s, power_k: k, shin_z: z };
  }
  var DEVIG_METHODS = ['proportional', 'power', 'additive', 'shin'];

  /* ==================================================== THE PROBABILITY
     Read from the champion's stored curve — the same lookup the Read makes.
     A quarter line is priced only through the settlement engine; a line
     outside the curve is not priced (never extrapolated, never 50%). */
  function probabilityAt(curve, side, line) {
    if (!curve || !halfPoint(line)) return null;
    var p = rd().sideProb(curve, side, line);
    if (!p) return null;
    return { win: p.win, push: p.push, loss: p.loss, cover: p.cover };
  }
  /* THE SAME FROZEN DISTRIBUTION, RE-CENTRED BY REWEIGHTING IT IN PLACE
     (2026-10-05). The calibration anchor below, and the model-location noise
     the robust EV samples, move the stored distribution by delta points.
     That move used to be a LOCATION move (home margin + delta, a fractional
     delta the mixture of the two neighbouring whole-point moves). It carried
     every spike off the margin it sits on and gave a tie the mass a college
     game cannot have. Once the champion stopped shifting its own row
     (football/cfb_p4/engine.js cfbRecentre, 2026-10-04), the anchored
     distribution on the 2023-2025 walk-forward folds pushed 2.9% of the time
     at integer market lines (raw 3.3%, observed 5.3%), put 4.1% of its mass
     on |margin| = 3 (raw 9.6%, games 10.5%), and 2.0% on a tie.

     The move is now the champion's own: the stored masses are reweighted by
     exp(theta * margin), theta solved so the mean moves by exactly delta.
     P(M = k) is read from curve.push at every whole k the curve holds; the
     mass past either end of the curve (P(M < first k), P(M > last k)) is
     weighted as if it sat one point past that end. Every margin keeps its
     own entry, so a spike stays on 3 and 7, and a margin the curve gives no
     mass (a tie, in college) keeps none. delta = 0 is the stored curve itself.
     The champion re-centres its row by this same tilt, and its volatility
     stretch is a ratio of normal densities on the same grid, which is a tilt
     too; so the anchored curve is the champion's row read at another fair
     margin (same row, same sigma) wherever the engine reweights rather than
     shifts. On the 2022-2025 closes it matches the engine re-run at that
     margin to 0.03 pp (median; 95th percentile 0.1 pp) at close +/- 3 and 7,
     the residual being the tail weighted at the curve's ends. */
  var TILT_MAX = 2;                                   /* |theta| per point: past it the mass sits at one end of the curve */
  function curvePmf(curve) {
    if (!curve || !curve.win || !curve.push || !isNum(curve.lo) || !isNum(curve.step)) return null;
    var ks = [], ps = [], first = -1, last = -1, i, t;
    for (i = 0; i < curve.win.length; i++) {
      t = curve.lo + i * curve.step;
      if (!isInt(t)) continue;
      if (first < 0) first = i;
      last = i;
      ks.push(Math.round(t)); ps.push(Math.max(0, num(curve.push[i]) || 0));
    }
    if (ks.length < 2) return null;
    var P = { ks: ks, ps: ps, below: Math.max(0, 1 - curve.win[first] - (num(curve.push[first]) || 0)), above: Math.max(0, curve.win[last]),
      k_below: ks[0] - 1, k_above: ks[ks.length - 1] + 1, mean: 0 };
    var T = tiltOf(P, 0);
    if (!T) return null;
    P.mean = T.mean;
    return P;
  }
  /* the masses times exp(theta * (k - mean)), normalised; the largest exponent
     sits at an end of the support and is taken out first (no overflow) */
  function tiltOf(P, th) {
    var c = P.mean, top = Math.max(th * (P.k_below - c), th * (P.k_above - c));
    var lo = P.below * Math.exp(th * (P.k_below - c) - top), hi = P.above * Math.exp(th * (P.k_above - c) - top);
    var w = [], z = lo + hi, m1 = lo * (P.k_below - c) + hi * (P.k_above - c), m2 = lo * (P.k_below - c) * (P.k_below - c) + hi * (P.k_above - c) * (P.k_above - c), i, x, d;
    for (i = 0; i < P.ks.length; i++) {
      d = P.ks[i] - c; x = P.ps[i] * Math.exp(th * d - top);
      w.push(x); z += x; m1 += x * d; m2 += x * d * d;
    }
    if (!(z > 0)) return null;
    for (i = 0; i < w.length; i++) w[i] /= z;
    m1 /= z; m2 /= z;
    return { theta: th, w: w, below: lo / z, above: hi / z, mean: c + m1, variance: Math.max(0, m2 - m1 * m1) };
  }
  /* theta that moves the mean by delta points (the mean rises with theta, at
     the rate of the variance: safeguarded Newton) */
  function thetaForMove(P, delta) {
    var target = P.mean + delta, tlo = -TILT_MAX, thi = TILT_MAX, th = 0, T, f, nt, k;
    T = tiltOf(P, tlo); if (!T || T.mean > target) return null;
    T = tiltOf(P, thi); if (!T || T.mean < target) return null;
    for (k = 0; k < 100; k++) {
      T = tiltOf(P, th);
      if (!T) return null;
      f = T.mean - target;
      if (Math.abs(f) < 1e-10) break;
      if (f > 0) thi = th; else tlo = th;
      nt = T.variance > 0 ? th - f / T.variance : (tlo + thi) / 2;
      if (!(nt > tlo && nt < thi)) nt = (tlo + thi) / 2;
      if (nt === th) break;
      th = nt;
    }
    return th;
  }
  /* the stored distribution re-centred by delta points, ready to read at any
     line on the curve (P: the curve's PMF, when the caller already holds it) */
  function recentred(curve, delta, P) {
    if (!curve || !isNum(delta)) return null;
    if (delta === 0) return { curve: curve, delta: 0, P: null, T: null };
    P = P || curvePmf(curve);
    if (!P) return null;
    var th = thetaForMove(P, delta);
    if (!isNum(th)) return null;
    var T = tiltOf(P, th);
    return T ? { curve: curve, delta: delta, P: P, T: T } : null;
  }
  /* win / push / loss for the HOME side at a home line H (home covers when
     margin > -H): exactly the stored curve's domain (a half point on it) */
  function readHome(R, homeLine) {
    if (!R || !halfPoint(homeLine)) return null;
    var a = rd().sideProb(R.curve, 'home', homeLine);
    if (!a) return null;
    if (!R.T) return { win: a.win, push: a.push, loss: a.loss, cover: a.cover };
    var t = -homeLine, ks = R.P.ks, w = R.T.w, win = R.T.above, push = 0, i;
    for (i = 0; i < ks.length; i++) { if (Math.abs(ks[i] - t) < 1e-9) push = w[i]; else if (ks[i] > t) win += w[i]; }
    var loss = Math.max(0, 1 - win - push);
    return { win: win, push: push, loss: loss, cover: win + loss > 0 ? win / (win + loss) : null };
  }
  function readSide(R, side, line) {
    var h = readHome(R, side === 'home' ? line : -line);
    if (!h) return null;
    return side === 'home' ? h : { win: h.loss, push: h.push, loss: h.win, cover: h.cover == null ? null : 1 - h.cover };
  }
  function recentredHome(curve, homeLine, delta) { return readHome(recentred(curve, delta), homeLine); }
  function recentredSide(curve, side, line, delta) { return readSide(recentred(curve, delta), side, line); }
  /* the move (points of mean) that gives the home side conditional cover q at
     home line H: theta by bisection (the cover rises with theta), null if the
     curve cannot reach q */
  function solveRecentre(curve, homeLine, q) {
    if (!isNum(q) || !halfPoint(homeLine)) return null;
    var P = curvePmf(curve);
    if (!P || !rd().sideProb(curve, 'home', homeLine)) return null;
    var cov = function (th) { var T = tiltOf(P, th), h = T ? readHome({ curve: curve, P: P, T: T }, homeLine) : null; return h && isNum(h.cover) ? h.cover : null; };
    var lo = -TILT_MAX, hi = TILT_MAX, flo = cov(lo), fhi = cov(hi), i, mid, f;
    if (!isNum(flo) || !isNum(fhi) || q < flo || q > fhi) return null;
    for (i = 0; i < 60; i++) { mid = (lo + hi) / 2; f = cov(mid); if (!isNum(f)) return null; if (f < q) lo = mid; else hi = mid; }
    var T = tiltOf(P, (lo + hi) / 2);
    return T ? T.mean - P.mean : null;
  }
  function curveSane(curve) {
    if (!curve || !curve.win || !curve.push || curve.win.length !== curve.push.length) return { ok: false, why: 'curve missing or malformed' };
    for (var i = 0; i < curve.win.length; i++) {
      var w = curve.win[i], p = curve.push[i];
      if (!isNum(w) || !isNum(p) || w < -1e-9 || p < -1e-9 || w + p > 1 + 1e-6) return { ok: false, why: 'probabilities outside [0,1] at index ' + i };
      if (i > 0 && w > curve.win[i - 1] + 1e-6) return { ok: false, why: 'P(margin > t) rises with t at index ' + i + ' (incoherent curve)' };
    }
    return { ok: true, why: null };
  }

  /* ======================================================== CALIBRATION
     The calibrator artifact (football/cfb_ev/artifacts/<version>/calibration.json)
     holds, per market key ('cfb|spread|close'), the tournament's verdict, the
     map, its fitting domain and the bootstrap draws the uncertainty layer
     uses. Only PROMOTED (a map that beat identity out of sample) or
     IDENTITY_VALIDATED (identity kept, and itself calibrated out of sample)
     may drive a decision. The map is FOOTBALL-ONLY: raw probability in,
     calibrated probability out; no market input exists in the schema. */
  function applyCalibrator(map, p) {
    if (!isNum(p)) return null;
    if (!map || map.method === 'identity') return p;
    switch (map.method) {
      case 'temperature': return sigm(logit(p) / map.T);
      case 'platt': case 'rolling_platt': return sigm(map.a + map.b * logit(p));
      case 'beta': case 'isotonic': return dec().applyMap({ method: map.method, a: map.a, b: map.b, c: map.c, x: map.x, y: map.y }, p);
      case 'venn_abers': return vennAbers(map, p).p;
      default: throw new Error('unknown calibrator ' + map.method);
    }
  }
  /* inductive Venn-Abers: two isotonic fits with the test score labelled 0 and 1 */
  function pav(xs, ys) {
    var blocks = [], i;
    for (i = 0; i < xs.length; i++) {
      blocks.push({ x0: xs[i], x1: xs[i], s: ys[i], w: 1 });
      while (blocks.length > 1) {
        var b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.s / a.w <= b.s / b.w) break;
        a.x1 = b.x1; a.s += b.s; a.w += b.w; blocks.pop();
      }
    }
    return blocks;
  }
  function isoAt(blocks, x) {
    for (var i = 0; i < blocks.length; i++) if (x >= blocks[i].x0 - 1e-15 && x <= blocks[i].x1 + 1e-15) return blocks[i].s / blocks[i].w;
    return null;
  }
  function vennAbers(map, p) {
    var xs = map.scores, ys = map.labels, idx = 0;
    while (idx < xs.length && xs[idx] < p) idx++;
    var X = xs.slice(0, idx).concat([p]).concat(xs.slice(idx));
    var Y0 = ys.slice(0, idx).concat([0]).concat(ys.slice(idx)), Y1 = ys.slice(0, idx).concat([1]).concat(ys.slice(idx));
    var p0 = isoAt(pav(X, Y0), p), p1 = isoAt(pav(X, Y1), p);
    return { p0: p0, p1: p1, p: p1 / (1 - p0 + p1) };
  }
  function calibrationFor(artifact, key, modelVersion) {
    var base = { key: key, status: 'MISSING', usable: false, version: null, method: null, map: null, reason: null, domain: null, uncertainty: null, n: null, maturity: 'PENDING' };
    if (!artifact || typeof artifact !== 'object') { base.reason = 'no EV calibration artifact loaded'; return base; }
    base.version = artifact.version || null;
    if (artifact.schema !== CAL_SCHEMA) { base.reason = 'unknown calibration schema ' + artifact.schema; return base; }
    if (!artifact.base_model_version || artifact.base_model_version !== modelVersion) {
      base.status = 'VERSION_MISMATCH'; base.reason = artifact.version + ' was fitted for ' + artifact.base_model_version + '; the projection is ' + (modelVersion || 'unknown'); return base;
    }
    var c = artifact.calibrators && artifact.calibrators[key];
    if (!c) { base.reason = 'no calibrator for ' + key; return base; }
    base.status = c.status; base.method = c.method; base.map = c.map || null; base.domain = c.domain || null; base.n = c.n || null;
    base.uncertainty = c.uncertainty || artifact.uncertainty || null; base.oof = c.oof || null; base.training_window = c.training_window || null;
    base.usable = c.status === 'PROMOTED' || c.status === 'IDENTITY_VALIDATED';
    base.maturity = base.usable ? (c.maturity || 'SHADOW') : 'PENDING';
    base.reason = base.usable ? null : (c.reason || ('the tournament did not validate a calibrator for ' + key + ' (' + c.status + ')'));
    return base;
  }
  /* the calibrator for a quote's checkpoint (pre-registered map: an opener or
     early-week quote reads the opener calibrator; everything later the close) */
  function calFor(ctx, checkpoint) {
    var key = (ctx.checkpoint_map && ctx.checkpoint_map[checkpoint]) || 'cfb|spread|close';
    if (key === (ctx.calibration && ctx.calibration.key)) return ctx.calibration;
    if (!ctx.calibrations[key]) ctx.calibrations[key] = calibrationFor(ctx.artifact, key, ctx.model.model_version);
    return ctx.calibrations[key];
  }
  /* THE ANCHOR. The tournament fitted every calibrator on the champion's raw
     probability AT THE MARKET LINE (the consensus close or opener), because
     that is where decisions are made — and that is the only domain the map
     is valid in. A map is therefore EVALUATED at the market line only (the
     anchor), and carried to every other line (alternates, what-ifs, the
     ladder) by the same frozen distribution, reweighted in place (recentred
     above) so that its cover probability at the anchor equals the calibrated
     one: the spikes stay on their margins and a tie keeps no mass. The map's inputs are
     football-only; the market line decides WHERE it is evaluated, never what
     it says, and no de-vigged price enters. With identity (δ = 0) the
     calibrated distribution IS the champion's. */
  function anchorOf(ctx, cal) {
    if (!cal || !cal.usable) return null;
    ctx._anchor = ctx._anchor || {};
    if (ctx._anchor[cal.key]) return ctx._anchor[cal.key];
    var H = ctx.anchor_home_line, out = { key: cal.key, home_line: isNum(H) ? H : null, source: ctx.anchor_source || null };
    if (!isNum(H) || !halfPoint(H)) { out.problem = 'no current market line to evaluate the calibrator at (it was fitted at the market line only)'; return (ctx._anchor[cal.key] = out); }
    var p0 = rd().sideProb(ctx.curve, 'home', H);
    if (!p0 || !isNum(p0.cover)) { out.problem = 'the market line is outside the stored curve'; return (ctx._anchor[cal.key] = out); }
    var q = clamp(applyCalibrator(cal.map, p0.cover), 1e-4, 1 - 1e-4);
    var d = Math.abs(q - p0.cover) < 1e-12 ? 0 : solveRecentre(ctx.curve, H, q);
    if (!isNum(d)) { out.problem = 'the calibrated probability at the market line cannot be reached by the stored curve'; return (ctx._anchor[cal.key] = out); }
    out.raw_home_cover = r(p0.cover); out.calibrated_home_cover = r(q); out.delta_pts = r(d, 4);
    out.text = 'calibrated at ' + ctx.game.home + ' ' + lineText(H) + ' (the market line): raw ' + pct(p0.cover, 1) + ' → ' + pct(q, 1) + '; the distribution is carried to other lines reweighted in place, its mean moved ' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2) + ' pts (every margin keeps its own mass)';
    return (ctx._anchor[cal.key] = out);
  }
  function calibratedAt(ctx, cal, side, line) {
    var A = anchorOf(ctx, cal);
    if (!A || A.problem) return null;
    /* built once per anchor (a context copied with its anchor reset re-builds it) */
    ctx._anchored = ctx._anchored || {};
    var M = ctx._anchored[cal.key];
    if (!M || M.anchor !== A || M.curve !== ctx.curve) M = ctx._anchored[cal.key] = { anchor: A, curve: ctx.curve, dist: recentred(ctx.curve, A.delta_pts) };
    var p = readSide(M.dist, side, line);
    return p ? { win: p.win, push: p.push, loss: p.loss, cover: p.cover, anchor: A } : null;
  }
  /* a side's calibrated conditional cover, through the home-oriented map, AT the anchor only */
  function calibratedCover(cal, side, sideCoverRaw) {
    if (!cal || !cal.usable || !isNum(sideCoverRaw)) return null;
    var h = side === 'away' ? 1 - sideCoverRaw : sideCoverRaw;
    var q = applyCalibrator(cal.map, h);
    if (!isNum(q)) return null;
    q = clamp(q, 1e-4, 1 - 1e-4);
    return side === 'away' ? 1 - q : q;
  }

  /* ================================================ UNCERTAINTY (ROBUST EV)
     A point probability is not known truth. Two sampled layers, shared by
     every option of a game (so comparisons are paired):
       1. CALIBRATION — the sampling uncertainty of the raw→outcome
          relationship at this probability: bootstrap Platt refits of the
          out-of-sample data (week-clustered), each draw's deviation from the
          full-data fit added to the calibrated point;
       2. MODEL LOCATION — the game's between-model disagreement in EXCESS of
          the typical disagreement already absorbed by the calibrated
          distribution: δ ~ N(0, τ²), τ² = max(0, sd² − sd_ref²), applied as
          a move of the fair margin (the curve reweighted so its mean moves
          by δ, as the champion moves its own row; recentred above).
     The conservative EV is the pre-registered 10th percentile; Pr(EV>0) is
     the share of samples above zero. Both are research signals until the
     record validates them. */
  function drawsFor(ctx) {
    var P = ctx.policy, U = ctx.calibration && ctx.calibration.uncertainty ? ctx.calibration.uncertainty : (ctx.uncertainty || null);
    var S = Math.max(50, Math.min(4000, P.samples || 500));
    var seed = parseInt(hash([ctx.game && ctx.game.game_id, ctx.model && ctx.model.model_version, ctx.calibration && ctx.calibration.version, 'ev']).slice(0, 8), 16);
    var rand = prng(seed), z = normalDraws(rand, S);
    var sd = ctx.agreement_sd, sdRef = U && isNum(U.sd_ref) ? U.sd_ref : null;
    var tau0 = isNum(sd) && isNum(sdRef) ? Math.sqrt(Math.max(0, sd * sd - sdRef * sdRef)) : 0;
    /* the model's location matters only as much as the calibrated probability still listens to it:
       the map's local slope in logit space at the anchor (identity 1; a map that discards the model's view 0) */
    var wModel = mapSlopeAtAnchor(ctx), tau = tau0 * wModel;
    var draws = U && U.platt_draws && U.platt_draws.length ? U.platt_draws : null;
    var out = [], i;
    for (i = 0; i < S; i++) out.push({ delta: tau * z[i], u: rand(), k: draws ? -2 : -1 });
    var layers = [];
    if (draws) layers.push('calibration (' + draws.length + ' week-clustered bootstrap refits)');
    if (tau > 0) layers.push('model location (τ ' + tau.toFixed(2) + ' pts: agreement SD ' + sd.toFixed(2) + ' beyond the typical ' + sdRef.toFixed(2) + ', × the calibrated weight ' + wModel.toFixed(2) + ' on the model’s view)');
    else if (tau0 > 0) layers.push('model location (none: the calibrated probability keeps ' + (100 * wModel).toFixed(0) + '% of the model’s view, so its location uncertainty does not move it)');
    else if (isNum(sd) && isNum(sdRef)) layers.push('model location (none: agreement SD ' + sd.toFixed(2) + ' within the typical ' + sdRef.toFixed(2) + ')');
    return { S: S, draws: out, platt: draws, center: U && U.platt_center ? U.platt_center : null, tau: tau, tau_unweighted: tau0, model_weight: wModel, sd: isNum(sd) ? sd : null, sd_ref: sdRef, layers: layers,
      complete: !!draws && (isNum(sd) || tau === 0), seed: seed };
  }
  /* per-sample moves (points of mean), shared by every option of the game
     (paired comparisons): calibrated → the anchor re-solved for each bootstrap
     draw of the calibration relationship, plus the excess model-location
     noise; raw → the location noise alone (and the calibration draws as a
     deviation) */
  function mapSlopeAtAnchor(ctx) {
    var cal = ctx.calibration;
    if (!cal || !cal.usable) return 1;
    var A = anchorOf(ctx, cal), p = A && isNum(A.raw_home_cover) ? A.raw_home_cover : 0.5, h = 0.05;
    var z = logit(p), a = applyCalibrator(cal.map, sigm(z - h)), b = applyCalibrator(cal.map, sigm(z + h));
    if (!isNum(a) || !isNum(b)) return 1;
    return clamp((logit(b) - logit(a)) / (2 * h), 0, 1);
  }
  function uncOf(ctx, cal) {
    var U = (cal && cal.uncertainty) || (ctx.calibration && ctx.calibration.uncertainty) || ctx.uncertainty || null;
    return U && U.platt_draws && U.platt_draws.length && U.platt_center ? U : null;
  }
  function anchorDeltas(ctx, cal) {
    var key = cal ? cal.key : 'raw';
    ctx._deltas = ctx._deltas || {};
    if (ctx._deltas[key]) return ctx._deltas[key];
    var DR = ctx._draws || (ctx._draws = drawsFor(ctx)), out = [], i;
    var A = cal ? anchorOf(ctx, cal) : null, U = uncOf(ctx, cal), c0 = U ? U.platt_center : null;
    var solved = {};
    for (i = 0; i < DR.S; i++) {
      var d = DR.draws[i], base = 0, k = U ? Math.floor(d.u * U.platt_draws.length) : -1;
      if (A && !A.problem) {
        base = A.delta_pts;
        if (U && k >= 0) {
          if (solved[k] == null) {
            var dr = U.platt_draws[k], p0 = A.raw_home_cover;
            var q = clamp(A.calibrated_home_cover + sigm(dr[0] + dr[1] * logit(p0)) - sigm(c0[0] + c0[1] * logit(p0)), 1e-4, 1 - 1e-4);
            var sd0 = solveRecentre(ctx.curve, A.home_line, q);
            solved[k] = isNum(sd0) ? sd0 : A.delta_pts;
          }
          base = solved[k];
        }
      }
      out.push(base + d.delta);
    }
    return (ctx._deltas[key] = out);
  }
  /* each sample's re-centred distribution, built once per set of moves and
     read at every option (a context copied with its moves reset re-builds it) */
  function sampleDists(ctx, cal) {
    var key = cal ? cal.key : 'raw', deltas = anchorDeltas(ctx, cal);
    ctx._dists = ctx._dists || {};
    var M = ctx._dists[key];
    if (M && M.deltas === deltas && M.curve === ctx.curve) return M.dists;
    var P = curvePmf(ctx.curve), memo = {}, out = [], i, d;
    for (i = 0; i < deltas.length; i++) {
      d = deltas[i];
      if (!has(memo, d)) memo[d] = recentred(ctx.curve, d, P);
      out.push(memo[d]);
    }
    ctx._dists[key] = { deltas: deltas, curve: ctx.curve, dists: out };
    return out;
  }
  function sampleStates(ctx, cal, side, line, point) {
    var DR = ctx._draws || (ctx._draws = drawsFor(ctx)), dists = sampleDists(ctx, cal), out = [], i, U = uncOf(ctx, cal), c0 = U ? U.platt_center : null;
    var hRaw = side === 'home' ? point.cover : 1 - point.cover;
    for (i = 0; i < DR.S; i++) {
      var p = readSide(dists[i], side, line);
      if (!p) { out.push(null); continue; }
      if (!cal && U && isNum(p.cover)) {
        /* raw path (experimental): the calibration-relationship draw as a deviation of the cover, push kept */
        var dr = U.platt_draws[Math.floor(DR.draws[i].u * U.platt_draws.length)], dev = sigm(dr[0] + dr[1] * logit(hRaw)) - sigm(c0[0] + c0[1] * logit(hRaw));
        var cv = clamp(p.cover + (side === 'home' ? dev : -dev), 1e-4, 1 - 1e-4);
        p = { win: cv * (1 - p.push), push: p.push, loss: (1 - cv) * (1 - p.push), cover: cv };
      }
      out.push(p);
    }
    return out;
  }
  function summarize(evs, P) {
    var s = sortNum(evs);
    if (!s.length) return null;
    var q = P.conservative_quantile, iv = P.interval;
    return { n: s.length, mean: mean(s), median: quantile(s, 0.5), ci_low: quantile(s, iv[0]), ci_high: quantile(s, iv[1]), interval: iv.slice(),
      conservative: quantile(s, q), conservative_quantile: q, prob_positive: s.filter(function (x) { return x > 0; }).length / s.length };
  }

  /* ============================================================ FRESHNESS
     Market-specific TTL (PREREG §7): a quote older than its TTL is not a
     price; inside the last hours before kickoff the TTL tightens; an extreme
     EV needs a younger quote still. */
  function ttlFor(policy, marketType, origin, alternate, kickoff, now, extreme) {
    var T = policy.ttl_minutes, t = origin === 'USER' ? T.user : (alternate ? T.alternate_spread : (T[marketType] || T.spread));
    var hk = ms(kickoff) != null && now != null ? (ms(kickoff) - now) / 3600000 : null;
    var basis = origin === 'USER' ? 'user quote' : (alternate ? 'alternate spread' : marketType);
    if (isNum(hk) && hk <= policy.near_kickoff_hours && hk > 0 && T.near_kickoff < t) { t = T.near_kickoff; basis += ', within ' + policy.near_kickoff_hours + ' h of kickoff'; }
    if (extreme && T.extreme < t) { t = T.extreme; basis += ', extreme EV'; }
    return { minutes: t, basis: basis, hours_to_kickoff: r(hk, 2) };
  }
  function quoteAge(q, now) { return rd().quoteAgeMinutes(q, now); }
  /* market checkpoint (the maturity at which a quote was taken) */
  function checkpointOf(observedAt, kickoff, isOpen) {
    if (isOpen) return 'OPEN';
    var h = ms(kickoff) != null && ms(observedAt) != null ? (ms(kickoff) - ms(observedAt)) / 3600000 : null;
    if (!isNum(h)) return 'UNKNOWN';
    if (h > 72) return 'EARLY_WEEK';
    if (h > 24) return 'MIDWEEK';
    if (h > 6) return 'T24';
    if (h > 1) return 'T6';
    return 'FINAL';
  }

  /* ============================================================ OPTIONS
     One OPTION = one side, one line, one price, one book, one moment. */
  function teamOf(ctx, side) { return side === 'home' ? ctx.game.home : ctx.game.away; }
  function fairLineForSide(ctx, side) { return side === 'home' ? -ctx.model.home_margin : ctx.model.home_margin; }
  function selectionId(ctx, side, market) { return String(ctx.game.game_id) + ':' + (market || 'spread') + ':' + side; }
  function evaluateOption(ctx, spec) {
    var P = ctx.policy, side = spec.side, line = num(spec.line), mt = spec.market_type || 'spread';
    var odds = spec.odds && spec.odds.valid !== undefined ? spec.odds : normalizeOdds(spec.price);
    var alt = !!spec.alternate, origin = spec.origin || 'LEDGER';
    var o = {
      selection_id: selectionId(ctx, side, alt ? 'alternate_spread' : mt), game_id: ctx.game.game_id, side: side, team: teamOf(ctx, side),
      market_type: alt ? 'alternate_spread' : mt, line: line, line_text: lineText(line), is_main_line: !alt,
      book: spec.book || null, book_key: spec.book ? rd().bookKey(spec.book) : null, source: spec.source || null, origin: origin, quote_id: spec.quote_id || null,
      quote_ts: iso(spec.observed_at), provider_updated_at: iso(spec.provider_updated_at),
      odds: odds.valid ? { american: odds.american, american_display: odds.american_display, decimal: odds.decimal, net_payout: odds.net_payout,
        implied_raw: odds.implied_raw, format: odds.format, precision: odds.precision, approximate_american: odds.approximate_american } : null,
      label: teamOf(ctx, side) + ' ' + lineText(line) + (odds.valid ? ' ' + priceText(odds.american_display) + (odds.approximate_american ? '*' : '') : ''),
      priced: !!odds.valid, problem: null, accessible: spec.accessible !== false
    };
    /* the settlement structure: never a binary shortcut */
    var sup = marketSupport(o.market_type);
    o.market_support = sup.status;
    if (quarterPoint(line)) { o.problem = 'a quarter line splits the stake (Asian handicap): EdgeDesk has no distribution for that market in this sport'; o.settlement = { structure: 'asian_quarter', supported: false }; return o; }
    if (!halfPoint(line)) { o.problem = 'the line ' + line + ' is not a half point'; return o; }
    o.settlement = { structure: isInt(line) ? 'two_way_integer' : 'two_way_half', states: isInt(line) ? ['FULL_WIN', 'PUSH', 'FULL_LOSS'] : ['FULL_WIN', 'FULL_LOSS'] };
    /* freshness */
    var age = spec.observed_at ? quoteAge({ observed_at: spec.observed_at, provider_updated_at: spec.provider_updated_at }, ctx.now) : null;
    var ttl = ttlFor(P, o.market_type === 'alternate_spread' ? 'spread' : o.market_type, origin, alt, ctx.game.kickoff, ctx.now, false);
    o.quote_age_seconds = isNum(age) ? Math.round(age * 60) : null;
    o.ttl_minutes = ttl.minutes; o.ttl_basis = ttl.basis;
    o.freshness = origin === 'HYPOTHETICAL' ? 'HYPOTHETICAL' : (!isNum(age) ? 'UNKNOWN' : (age < -5 ? 'CLOCK_FAULT' : (age > ttl.minutes ? 'STALE' : (age > ttl.minutes / 2 ? 'AGING' : 'FRESH'))));
    o.quote_fresh = o.freshness === 'FRESH' || o.freshness === 'AGING';
    o.market_checkpoint = origin === 'HYPOTHETICAL' ? 'HYPOTHETICAL' : checkpointOf(spec.observed_at, ctx.game.kickoff, origin === 'OPEN');
    /* the probability, from the frozen curve */
    var p = probabilityAt(ctx.curve, side, line);
    if (!p) { o.problem = 'the line is outside the stored probability curve'; return o; }
    o.p_win_raw = r(p.win); o.p_push_raw = r(p.push); o.p_loss_raw = r(p.loss); o.p_cover_raw = r(p.cover);
    o.fair_line_for_side = r(fairLineForSide(ctx, side), 3); o.cushion = r(line - fairLineForSide(ctx, side), 3);
    if (!odds.valid) { o.problem = odds.problem || 'no price on this side'; return o; }
    var dd = odds.decimal, be = breakEven(dd, p.push);
    o.break_even_probability = r(be.conditional_nonpush); o.break_even_unconditional = r(be.unconditional);
    o.break_even_basis = 'CONDITIONAL_NO_PUSH';
    o.raw_probability_edge = r(p.cover - be.conditional_nonpush);
    o.raw_model_ev = r(twoWayEv(p.win, p.push, dd));
    /* calibrated: the checkpoint's calibrator, evaluated at the market line and carried here by the frozen distribution */
    /* a typed or hypothetical price is judged as of NOW: the calibrator of the current checkpoint, the same one a live quote gets */
    var calCp = origin === 'HYPOTHETICAL' || origin === 'USER' || origin === 'CONSENSUS' ? checkpointOf(iso(ctx.now), ctx.game.kickoff, false) : o.market_checkpoint;
    var cal = calFor(ctx, calCp), ca = cal && cal.usable ? calibratedAt(ctx, cal, side, line) : null, qc = ca ? ca.cover : null;
    o.calibration_key = cal ? cal.key : null;
    if (isNum(qc)) {
      o.p_cover_calibrated = r(qc); o.p_push_calibrated = r(ca.push); o.p_win_calibrated = r(ca.win); o.p_loss_calibrated = r(ca.loss);
      o.probability_edge = r(qc - be.conditional_nonpush);
      o.probability_edge_unconditional = r(ca.win - breakEven(dd, ca.push).unconditional);
      o.calibrated_ev = r(twoWayEv(ca.win, ca.push, dd));
      o.calibration_method = cal.method; o.calibrator_version = cal.version;
      o.calibration_anchor = { home_line: ca.anchor.home_line, delta_pts: ca.anchor.delta_pts, raw_home_cover: ca.anchor.raw_home_cover, calibrated_home_cover: ca.anchor.calibrated_home_cover };
      var fd = fairDecimal(ca.win, ca.push);
      o.fair_decimal = r(fd); o.fair_american = isNum(fd) ? decimalToAmericanRounded(fd) : null;
    } else {
      o.p_cover_calibrated = null; o.p_push_calibrated = null; o.p_win_calibrated = null; o.p_loss_calibrated = null;
      o.probability_edge = null; o.probability_edge_unconditional = null; o.calibrated_ev = null; o.calibration_method = null; o.calibrator_version = cal ? cal.version : null;
      o.calibration_unavailable = !cal ? 'no calibrator' : (!cal.usable ? cal.reason : ((anchorOf(ctx, cal) || {}).problem || 'the calibrated probability could not be computed'));
      var fr = fairDecimal(p.win, p.push); o.fair_decimal = r(fr); o.fair_american = isNum(fr) ? decimalToAmericanRounded(fr) : null;
    }
    o.probability_basis = isNum(qc) ? 'CALIBRATED' : 'RAW';
    /* key numbers between the market line and this line: the audit decides whether their mass is trusted */
    if (isNum(ctx.anchor_home_line)) {
      var mLine = side === 'home' ? ctx.anchor_home_line : -ctx.anchor_home_line;
      o.market_line_for_side = mLine; o.alt_distance_points = r(line - mLine, 2);
      o.key_numbers_from_market = Math.abs(line - mLine) > 1e-9 ? keyCrossed(ctx, side, mLine, line).filter(function (k) { return k.is_key_number; }) : [];
      var prim = ctx.key_numbers && ctx.key_numbers.primary ? ctx.key_numbers.primary : [3, 7];
      o.key_number_unvalidated = !!(ctx.key_numbers && ctx.key_numbers.validated === false && o.key_numbers_from_market.some(function (k) { return prim.indexOf(k.key) >= 0; }));
    }
    o.ev_roi_pct = isNum(o.calibrated_ev) ? r(100 * o.calibrated_ev, 3) : null;
    o.ev_dollars_per_100 = isNum(o.calibrated_ev) ? r(100 * o.calibrated_ev, 2) : null;
    /* robust */
    var sm0 = sampleStates(ctx, isNum(qc) ? cal : null, side, line, p);
    var evs = sm0.map(function (x) { return x ? x.win * (dd - 1) - x.loss : null; });
    o._evs = evs;
    var sm = summarize(evs, P);
    o.robust = sm ? { basis: isNum(qc) ? 'CALIBRATED' : 'RAW (experimental)', n: sm.n, mean: r(sm.mean), median: r(sm.median), ci_low: r(sm.ci_low), ci_high: r(sm.ci_high),
      interval: sm.interval, conservative: r(sm.conservative), conservative_quantile: sm.conservative_quantile, prob_positive: r(sm.prob_positive, 4),
      layers: ctx._draws.layers, complete: ctx._draws.complete } : null;
    o.conservative_ev = sm ? r(sm.conservative) : null; o.ev_ci_low = sm ? r(sm.ci_low) : null; o.ev_ci_high = sm ? r(sm.ci_high) : null; o.prob_ev_positive = sm ? r(sm.prob_positive, 4) : null;
    /* the market's own probability: a benchmark, labelled */
    o.market_benchmark = spec.other_price != null ? marketBenchmark(odds, normalizeOdds(spec.other_price)) : null;
    /* the policy */
    var edgeOk = isNum(o.probability_edge) && o.probability_edge >= P.min_probability_edge - 1e-12;
    var evOk = isNum(o.calibrated_ev) && o.calibrated_ev >= P.min_calibrated_ev - 1e-12;
    var consOk = isNum(o.conservative_ev) && o.conservative_ev >= P.min_conservative_ev - 1e-12 && isNum(qc) && !!(o.robust && o.robust.complete);
    o.policy_checks = { calibrated: isNum(qc), probability_edge: edgeOk, calibrated_ev: evOk, conservative_ev: consOk };
    o.policy_clears = isNum(qc) && edgeOk && evOk && consOk;
    /* the raw threshold (research only, never a decision): the same numbers on the raw probability */
    o.raw_clears = isNum(o.raw_probability_edge) && o.raw_probability_edge >= P.min_probability_edge - 1e-12 && isNum(o.raw_model_ev) && o.raw_model_ev >= 0 && isNum(o.conservative_ev) && o.conservative_ev >= 0;
    o.within_price_limit = isNum(P.max_price) ? dd - 1 >= dec().americanToPayout(P.max_price) - 1e-12 : true;
    o.grade = o.policy_clears ? 'CLEARS' : (isNum(o.calibrated_ev) ? (o.calibrated_ev > 0 ? 'MARGINAL' : 'NEGATIVE EV') : (o.raw_clears ? 'RAW CLEARS (EXPERIMENTAL)' : (isNum(o.raw_model_ev) && o.raw_model_ev > 0 ? 'RAW MARGINAL' : 'RAW NEGATIVE')));
    return o;
  }
  function marketBenchmark(a, b) {
    if (!a || !a.valid || !b || !b.valid) return null;
    var out = { note: 'the market’s own probability for this side, de-vigged from both sides of the same quote — a benchmark, never EdgeDesk’s probability', methods: {} };
    DEVIG_METHODS.forEach(function (m) { var d = devig([a.decimal, b.decimal], m); out.methods[m] = d.ok ? r(d.p[0]) : null; });
    out.overround = r(1 / a.decimal + 1 / b.decimal - 1);
    out.display_method = 'proportional';
    out.value = out.methods.proportional;
    return out;
  }
  function stripOption(o) { if (!o) return null; var x = {}, k; for (k in o) if (has(o, k) && k.charAt(0) !== '_') x[k] = o[k]; return x; }

  /* rank by value: calibrated → conservative EV, then calibrated EV; raw (pending) → raw EV, labelled */
  function valueKey(o) {
    if (!o || !o.priced || o.problem) return -9;
    if (isNum(o.conservative_ev) && o.probability_basis === 'CALIBRATED') return o.conservative_ev;
    return isNum(o.raw_model_ev) ? o.raw_model_ev - 1 : -9;          /* raw ranks below any calibrated option */
  }
  function rankValue(a, b) {
    var d = valueKey(b) - valueKey(a);
    if (Math.abs(d) > 1e-12) return d;
    var ea = isNum(a.calibrated_ev) ? a.calibrated_ev : a.raw_model_ev, eb = isNum(b.calibrated_ev) ? b.calibrated_ev : b.raw_model_ev;
    if (isNum(ea) && isNum(eb) && Math.abs(eb - ea) > 1e-12) return eb - ea;
    return (a.break_even_probability || 1) - (b.break_even_probability || 1);
  }

  /* ============================================= MAIN VS ALT / THE JUICE
     "Is buying the extra point worth it?" — the increase in cover probability
     against the increase in break-even, then the EV difference, paired over
     the same uncertainty samples. A safer line is never better for being safer. */
  function keyCrossed(ctx, side, fromLine, toLine) {
    var lo = Math.min(fromLine, toLine), hi = Math.max(fromLine, toLine), out = [], k;
    for (k = Math.ceil(-hi - 1e-9); k <= Math.floor(-lo + 1e-9); k++) {
      var ak = Math.abs(k), mass = rd().massAt(ctx.curve, side, k);
      out.push({ margin: k, key: ak, is_key_number: (ctx.policy.timing.key_numbers || []).indexOf(ak) >= 0, game_mass: r(mass, 5),
        historical_share: ctx.key_mass && isNum(ctx.key_mass[ak]) ? ctx.key_mass[ak] : null });
    }
    return out;
  }
  function juice(ctx, a, b) {
    if (!a || !b || !a.priced || !b.priced || a.problem || b.problem) return { verdict: 'NO_DECISION', why: 'both prices must be complete and priceable', explanation: [] };
    if (a.side !== b.side) return { verdict: 'NO_DECISION', why: 'compare two prices for the same side', explanation: [] };
    var P = ctx.policy, cal = a.probability_basis === 'CALIBRATED' && b.probability_basis === 'CALIBRATED';
    var dLine = b.line - a.line;
    var winA = cal ? a.p_win_calibrated : a.p_win_raw, winB = cal ? b.p_win_calibrated : b.p_win_raw;
    var covA = cal ? a.p_cover_calibrated : a.p_cover_raw, covB = cal ? b.p_cover_calibrated : b.p_cover_raw;
    var evA = cal ? a.calibrated_ev : a.raw_model_ev, evB = cal ? b.calibrated_ev : b.raw_model_ev;
    var dEv = evB - evA, paired = [], i;
    for (i = 0; i < (a._evs || []).length; i++) if (isNum(a._evs[i]) && isNum(b._evs[i])) paired.push(b._evs[i] - a._evs[i]);
    var prB = paired.length ? paired.filter(function (x) { return x > 0; }).length / paired.length : null;
    var dRob = isNum(a.conservative_ev) && isNum(b.conservative_ev) ? b.conservative_ev - a.conservative_ev : null;
    var verdict;
    if (Math.abs(dEv) <= P.juice.ev_equivalent || !isNum(prB)) verdict = 'TOO_CLOSE';
    else if (dEv > 0 && prB >= P.juice.min_pr) verdict = 'BETTER_VALUE';
    else if (dEv < 0 && prB <= 1 - P.juice.min_pr) verdict = 'WORSE_VALUE';
    else verdict = 'TOO_CLOSE';
    var keys = dLine !== 0 ? keyCrossed(ctx, a.side, a.line, b.line) : [];
    var mass = keys.reduce(function (s, k) { return s + (isNum(k.game_mass) ? k.game_mass : 0); }, 0);
    var lines = [];
    if (dLine !== 0) lines.push((dLine > 0 ? 'EXTRA ' : 'GIVING UP ') + pts(Math.abs(dLine)));
    lines.push(ppText(winB - winA) + ' model ' + (cal ? 'calibrated ' : 'raw ') + 'win probability (' + ppText(covB - covA) + ' cover, no-push basis)');
    lines.push(ppText(b.break_even_probability - a.break_even_probability) + ' required break-even');
    lines.push('EV ' + (dEv >= 0 ? 'rises' : 'falls') + ' from ' + evText(evA) + ' to ' + evText(evB) + (cal ? '' : ' (raw, experimental)'));
    if (keys.some(function (k) { return k.is_key_number; }) && ctx.key_numbers && ctx.key_numbers.validated === false) lines.push('KEY-NUMBER MASS NOT VALIDATED: the audit found the distribution under-states pushes on key numbers, so this comparison cannot be actionable');
    if (keys.some(function (k) { return k.is_key_number; })) lines.push('KEY NUMBER CROSSED: ' + keys.filter(function (k) { return k.is_key_number; }).map(function (k) { return k.key + ' (' + pct(k.game_mass, 1) + ' of this game lands exactly there' + (isNum(k.historical_share) ? '; ' + pct(k.historical_share, 1) + ' of FBS games' : '') + ')'; }).join(', '));
    return {
      from: a.label, to: b.label, from_book: a.book, to_book: b.book, basis: cal ? 'CALIBRATED' : 'RAW (experimental)',
      points_gained: r(dLine, 2), delta_win: r(winB - winA), delta_cover: r(covB - covA), delta_break_even: r(b.break_even_probability - a.break_even_probability),
      delta_break_even_unconditional: r(b.break_even_unconditional - a.break_even_unconditional),
      delta_ev: r(dEv), delta_conservative_ev: r(dRob), pr_b_better: r(prB, 4), juice_cost_cents: isNum(a.odds.american_display) && isNum(b.odds.american_display) ? juiceCents(a.odds.american_display, b.odds.american_display) : null,
      incremental_value: r((covB - covA) - (b.break_even_probability - a.break_even_probability)),
      key_numbers: keys.filter(function (k) { return k.is_key_number; }), crossed_margins: keys, incremental_push_or_cover_mass: r(mass, 5),
      verdict: verdict, explanation: lines,
      why: verdict === 'BETTER_VALUE' ? b.label + ' is better value than ' + a.label + ' (paired Pr ' + pct(prB, 0) + ').'
        : (verdict === 'WORSE_VALUE' ? b.label + ' is worse value than ' + a.label + ': ' + (dLine > 0 ? 'the protection costs more than it adds.' : 'the cheaper price gives up more than it saves.')
        : 'Too close to call on EdgeDesk’s numbers (paired Pr ' + pct(prB, 0) + ', ΔEV ' + evText(dEv) + ').')
    };
  }
  /* + = the alternative charges more (−115 → −140 is +25 cents), as the Read counts it */
  function juiceCents(from, to) { var f = function (x) { return x < 0 ? x + 100 : x - 100; }; return f(from) - f(to); }

  /* ======================================== BETTABLE TO / TARGET / ZERO EV
     All three solve the SAME policy the current quote is judged by. */
  function hypothetical(ctx, side, line, price, extra) {
    return evaluateOption(ctx, Object.assign({ side: side, line: line, price: price, origin: 'HYPOTHETICAL', book: extra && extra.book || null, alternate: false }, extra || {}));
  }
  /* the worst price at this line that still clears the policy: conservative EV is increasing in the payout, so bisect */
  function worstClearingPrice(ctx, side, line) {
    var hiOpt = hypothetical(ctx, side, line, { decimal: 11 });
    if (!hiOpt.policy_clears) return null;
    var lo = 1.001, hi = 11, i;
    for (i = 0; i < 40; i++) { var mid = (lo + hi) / 2; if (hypothetical(ctx, side, line, { decimal: mid }).policy_clears) hi = mid; else lo = mid; }
    /* to a whole American cent, rounded toward the bettor (never a price that fails) */
    var a = decimalToAmerican(hi), am = a < 0 ? Math.ceil(a) : Math.ceil(a);
    if (am > -100 && am < 100) am = 100;
    for (i = 0; i < 20 && !hypothetical(ctx, side, line, am).policy_clears; i++) am = am < 0 ? (am + 1 > -100 ? 100 : am + 1) : am + 1;
    return am;
  }
  function priceTargets(ctx, side, cur) {
    var P = ctx.policy, out = { side: side, basis: ctx.calibration && ctx.calibration.usable ? 'CALIBRATED policy' : 'RAW (experimental: no validated calibrator)', current: cur ? cur.label : null };
    if (!ctx.calibration || !ctx.calibration.usable) {
      /* a raw threshold, labelled: the same search on the raw probability */
      out.raw_threshold = rawBettable(ctx, side, cur);
      out.bettable_to = null; out.target = null;
      out.text = out.raw_threshold && isNum(out.raw_threshold.line) ? 'RAW THRESHOLD (experimental): ' + teamOf(ctx, side) + ' ' + lineText(out.raw_threshold.line) + ' ' + priceText(P.reference_price) + ' or better' : 'No calibrated threshold exists.';
      return out;
    }
    var start = cur && isNum(cur.line) ? cur.line : Math.round(fairLineForSide(ctx, side) * 2) / 2, L, worstLineRef = null, worstLineCur = null;
    for (L = start + 10; L >= start - 10 - 1e-9; L -= 0.5) {
      if (hypothetical(ctx, side, L, P.reference_price).policy_clears) worstLineRef = L; else if (worstLineRef != null) break;
    }
    if (cur && cur.priced) {
      for (L = start + 10; L >= start - 10 - 1e-9; L -= 0.5) {
        if (hypothetical(ctx, side, L, cur.odds.american).policy_clears) worstLineCur = L; else if (worstLineCur != null) break;
      }
    }
    var worstPrice = cur ? worstClearingPrice(ctx, side, cur.line) : null;
    out.bettable_to = { line_at_reference_price: worstLineRef, reference_price: P.reference_price, line_at_current_price: worstLineCur,
      current_price: cur && cur.odds ? cur.odds.american_display : null, price_at_current_line: worstPrice };
    out.clears_now = !!(cur && cur.policy_clears);
    out.ev_zero = cur && isNum(cur.fair_american) ? { price_at_current_line: cur.fair_american, text: 'EV is zero at ' + teamOf(ctx, side) + ' ' + lineText(cur.line) + ' ' + priceText(cur.fair_american) + ' (the calibrated fair price)' } : null;
    if (cur && !cur.policy_clears) {
      out.target = { line: isNum(worstLineCur) && worstLineCur > cur.line ? worstLineCur : null, price_at_line: cur.line, price: worstPrice,
        text: 'CURRENT ' + cur.label + ' → TARGET ' + [isNum(worstLineCur) && worstLineCur > cur.line ? teamOf(ctx, side) + ' ' + lineText(worstLineCur) + ' ' + priceText(cur.odds.american_display) : null,
          isNum(worstPrice) ? teamOf(ctx, side) + ' ' + lineText(cur.line) + ' ' + priceText(worstPrice) : null].filter(Boolean).join(' OR '),
        distance_pts: isNum(worstLineCur) && worstLineCur > cur.line ? r(worstLineCur - cur.line, 2) : null };
      if (!out.target.line && !isNum(out.target.price)) out.target = null;
    } else out.target = null;
    out.text = out.clears_now ? 'BETTABLE TO ' + [isNum(worstLineCur) ? teamOf(ctx, side) + ' ' + lineText(worstLineCur) + ' ' + priceText(cur.odds.american_display) : null,
      isNum(worstPrice) ? lineText(cur.line) + ' down to ' + priceText(worstPrice) : null, isNum(worstLineRef) ? lineText(worstLineRef) + ' ' + priceText(P.reference_price) + ' equivalent' : null].filter(Boolean).join(' · ')
      : (out.target ? out.target.text : 'No price within ten points clears the policy.');
    return out;
  }
  function rawBettable(ctx, side, cur) {
    var P = ctx.policy, start = cur && isNum(cur.line) ? cur.line : Math.round(fairLineForSide(ctx, side) * 2) / 2, L, found = null;
    for (L = start + 10; L >= start - 10 - 1e-9; L -= 0.5) { if (hypothetical(ctx, side, L, P.reference_price).raw_clears) found = L; else if (found != null) break; }
    return { line: found, price: P.reference_price, label: 'RAW THRESHOLD (experimental — no validated calibrator)' };
  }

  /* ============================================== PRICE GONE / EDGE DECAY */
  function edgeDecay(initial, current) {
    var out = { state: 'NO_INITIAL_EDGE', initial_probability_edge: null, current_probability_edge: null, initial_ev: null, current_ev: null, decay_pct: null, text: null };
    if (!initial) { out.text = 'No earlier eligible read for this side.'; return out; }
    out.initial_probability_edge = initial.edge; out.initial_ev = initial.ev; out.initial_label = initial.label; out.initial_at = initial.at;
    if (!current) { out.state = 'NO_CURRENT_PRICE'; out.text = 'No current price on this side.'; return out; }
    out.current_probability_edge = current.edge; out.current_ev = current.ev; out.current_label = current.label;
    if (!isNum(initial.edge) || initial.edge <= 0) { out.state = 'NO_INITIAL_EDGE'; out.text = 'The first read had no positive edge.'; return out; }
    if (!isNum(current.edge)) { out.state = 'UNKNOWN'; return out; }
    if (current.edge < 0) {
      out.state = 'REVERSED'; out.decay_pct = null;
      out.text = 'EDGE REVERSED: ' + ppText(initial.edge) + ' at ' + initial.label + ' → ' + ppText(current.edge) + ' at ' + current.label + '. A share-lost ratio is not meaningful across a sign flip.';
      return out;
    }
    var ratio = current.edge / initial.edge;
    out.decay_pct = r(1 - ratio, 4);
    out.state = ratio > 1.1 ? 'GREW' : (ratio >= 0.75 ? 'RETAINED' : (ratio >= 0.4 ? 'PARTIAL' : (ratio > 0 ? 'MOSTLY_GONE' : 'VANISHED')));
    out.text = { GREW: 'The edge grew: ', RETAINED: 'The edge is retained: ', PARTIAL: 'Part of the edge is gone: ', MOSTLY_GONE: 'Most of the edge is gone: ', VANISHED: 'The edge is gone: ' }[out.state]
      + ppText(initial.edge) + ' at ' + initial.label + ' → ' + ppText(current.edge) + ' at ' + current.label + '.';
    return out;
  }

  /* ========================================= EXTREME-EV CIRCUIT BREAKER
     Large EV needs MORE scrutiny, never a cap. Thresholds are the out-of-
     sample percentiles stored in the calibration artifact. */
  function circuitBreaker(ctx, cur, read) {
    var X = ctx.extremes, out = { triggered: false, level: 'NONE', checks: [], verified: null, thresholds: X || null, text: null };
    if (!cur || !cur.priced || cur.problem) return out;
    var gap = read && read.model_market_gap ? read.model_market_gap.points : null;
    var pe = isNum(cur.p_cover_raw) ? Math.abs(cur.p_cover_raw - 0.5) : null;
    if (!X) { out.level = 'UNKNOWN'; out.text = 'No out-of-sample percentiles on file: extreme EVs cannot be screened, so none is actionable.'; out.triggered = true; out.verified = false; return out; }
    var lvl = 'NONE';
    if ((isNum(pe) && pe >= X.prob_p99) || (isNum(gap) && gap >= X.gap_p99)) lvl = 'SEVERE';
    else if ((isNum(pe) && pe >= X.prob_p95) || (isNum(gap) && gap >= X.gap_p95)) lvl = 'REVIEW';
    out.level = lvl; out.triggered = lvl !== 'NONE';
    if (!out.triggered) return out;
    function add(id, status, detail) { out.checks.push({ id: id, status: status, detail: detail }); }
    var age = isNum(cur.quote_age_seconds) ? cur.quote_age_seconds / 60 : null;
    add('QUOTE_VERIFICATION', cur.origin === 'LEDGER' && isNum(age) && age <= ctx.policy.ttl_minutes.extreme && cur.market_benchmark ? 'PASS' : 'FAIL',
      'an extreme EV needs a captured two-sided quote under ' + ctx.policy.ttl_minutes.extreme + ' min old (this one: ' + (isNum(age) ? Math.round(age) + ' min' : 'unknown age') + ', ' + (cur.market_benchmark ? 'two-sided' : 'one-sided') + ', ' + cur.origin + ')');
    var mh = read && read.market_consensus_spread ? read.market_consensus_spread.home_line : null, fair = ctx.model.home_margin;
    /* decision.js integrityCheck's orientation rule: flipping the market's sign would reconcile a 21+ point gap to within 7 */
    add('SIGN_ORIENTATION', isNum(mh) && isNum(gap) && gap > 21 && Math.abs(fair - mh) <= 7 ? 'FAIL' : (isNum(mh) ? 'PASS' : 'UNKNOWN'),
      'a 21+ point gap that reconciles within 7 points once the market sign is flipped is a sign fault, not an edge');
    var flip = isNum(mh) && Math.abs(fair) >= 0.5 && Math.abs(mh) >= 0.5 && Math.sign(fair) !== Math.sign(-mh);
    add('FAVORITE_FLIP_REVIEW', !flip ? 'PASS' : (read && read.research_status && read.research_status.verified ? 'PASS' : 'FAIL'),
      flip ? 'EdgeDesk and the market favour opposite sides: the integrity gate must have verified the gap' : 'no favourite flip');
    var cs = curveSane(ctx.curve);
    add('DISTRIBUTION_SANITY', cs.ok ? 'PASS' : 'FAIL', cs.ok ? 'the stored curve is a coherent distribution' : cs.why);
    var ag = read && read.model_agreement;
    add('COMPONENT_DISAGREEMENT', ag && ag.available ? (ag.label === 'WEAK' ? 'FAIL' : 'PASS') : 'UNKNOWN', ag && ag.available ? 'model agreement ' + ag.label + (isNum(ag.sd) ? ' (SD ' + ag.sd.toFixed(1) + ' pts)' : '') : 'fewer than two independent model numbers');
    /* the calibrator is evaluated at the market line (the anchor): that raw probability must lie in its fitted domain */
    var dom = ctx.calibration && ctx.calibration.domain, anc = ctx.calibration && ctx.calibration.usable ? anchorOf(ctx, ctx.calibration) : null;
    var hRaw = anc && isNum(anc.raw_home_cover) ? anc.raw_home_cover : (cur.side === 'home' ? cur.p_cover_raw : 1 - cur.p_cover_raw);
    add('CALIBRATION_DOMAIN', dom && isNum(dom.p01) ? (hRaw >= dom.p01 && hRaw <= dom.p99 ? 'PASS' : 'FAIL') : 'UNKNOWN',
      dom && isNum(dom.p01) ? 'raw probability ' + pct(hRaw, 1) + ' vs the calibrator’s fitted range ' + pct(dom.p01, 1) + '–' + pct(dom.p99, 1) + (hRaw >= dom.p01 && hRaw <= dom.p99 ? '' : ': extrapolation') : 'no fitted domain on file');
    out.verified = out.checks.every(function (c) { return c.status === 'PASS'; });
    out.text = (lvl === 'SEVERE' ? 'SEVERE' : 'EXTREME') + ' EV REVIEW: the raw edge or the model-market gap is beyond the out-of-sample ' + (lvl === 'SEVERE' ? '99th' : '95th') + ' percentile. '
      + (out.verified ? 'Every check passed.' : 'Not actionable until verified: ' + out.checks.filter(function (c) { return c.status !== 'PASS'; }).map(function (c) { return c.id.replace(/_/g, ' ').toLowerCase() + ' ' + c.status; }).join('; ') + '.');
    return out;
  }

  /* ===================================================== RECHECK A QUOTE
     Immediately before an actionable status: does the selected price still
     exist? If it changed, the probability and EV are recomputed at the new
     line and price; a cached card never preserves an extinct edge. */
  function recheck(ctx, option, quotes) {
    if (!option || option.origin !== 'LEDGER') return { status: option && option.origin === 'USER' ? 'USER_QUOTE' : 'NOT_APPLICABLE', option: option };
    var live = (quotes || []).filter(function (q) { return rd().bookKey(q.book) === option.book_key && !!q.alternate === !option.is_main_line; });
    if (!option.is_main_line) live = live.filter(function (q) { var l = option.side === 'home' ? q.home_line : -q.home_line; return Math.abs(l - option.line) < 1e-9; });
    live.sort(function (a, b) { return ms(b.observed_at) - ms(a.observed_at); });
    var q = live[0];
    if (!q) return { status: 'UNAVAILABLE', text: 'The selected price is no longer on file at ' + option.book + '.', option: null };
    var line = option.side === 'home' ? num(q.home_line) : -num(q.home_line);
    var pr = rd().sidePriceOf(rd().normalizeQuote(q, 0), option.side);
    var price = pr && pr.valid ? pr.american : null;
    var same = Math.abs(line - option.line) < 1e-9 && isNum(price) && option.odds && Math.round(price) === Math.round(option.odds.american_display) && q.quote_id === option.quote_id;
    if (same) return { status: option.quote_fresh ? 'CONFIRMED' : 'STALE', text: option.quote_fresh ? 'The price is still the newest capture at ' + option.book + '.' : 'The price is still the newest capture, but it is older than its TTL.', option: option };
    var now = evaluateOption(ctx, { side: option.side, line: line, price: price, book: q.book, source: q.source, origin: 'LEDGER', quote_id: q.quote_id,
      observed_at: q.observed_at, provider_updated_at: q.provider_updated_at, alternate: !option.is_main_line,
      other_price: option.side === 'home' ? q.price_away : q.price_home });
    return { status: 'REQUOTED', text: 'The price changed: ' + option.label + ' → ' + now.label + '; probability and EV recomputed at the new number.', option: now, previous: option.label };
  }

  /* ================================================================ THE EV READ
     input  the Read input (EDRead.fromTerminal's output: the stored curve,
            quotes, research object context) — the same object the Read card
            is built from, so the two cards never price from different data
     read   the Read built from that input (research status, consensus,
            movement, QB state, quote check) — recomputed if absent
     ev     { artifact, policy, history (earlier frozen EV snapshots of this
            game), books (the reader's accessible books), now } */
  function contextOf(input, ev) {
    ev = ev || {};
    var m = input.model || {}, g = input.game || {};
    var P = policyOf(ev.policy);
    if (ev.typical_move_pts != null) P.timing.typical_move_pts = ev.typical_move_pts;
    else if (input.config && isNum(num(input.config.typical_move_pts))) P.timing.typical_move_pts = num(input.config.typical_move_pts);
    var now = ms(ev.now != null ? ev.now : input.now); if (now === null) now = Date.now();
    var A = ev.artifact || null;
    var cps = A && A.checkpoint_map ? A.checkpoint_map : {};
    var nowCp = checkpointOf(iso(now), g.kickoff, false);
    var cal = calibrationFor(A, cps[nowCp] || 'cfb|spread|close', m.model_version);
    return { policy: P, now: now, game: { game_id: g.game_id != null ? String(g.game_id) : null, home: g.home, away: g.away, kickoff: g.kickoff || null, season: g.season, week: g.week },
      model: { available: !!(m.available && isNum(num(m.home_margin))), model_version: m.model_version || null, home_margin: num(m.home_margin), home_win_prob: num(m.home_win_prob) },
      curve: input.curve || null, calibration: cal, calibrations: {}, checkpoint_map: cps, artifact: A, extremes: A && A.extremes ? A.extremes : null,
      key_numbers: A && A.key_numbers ? A.key_numbers : null,
      anchor_home_line: isNum(num(ev.anchor_home_line)) ? num(ev.anchor_home_line) : null, anchor_source: ev.anchor_source || null,
      uncertainty: A && A.uncertainty ? A.uncertainty : null, key_mass: (input.context && input.context.key_mass) || null,
      agreement_sd: input.context && input.context.agreement && isNum(num(input.context.agreement.sd)) ? num(input.context.agreement.sd) : null,
      prediction_ts: ev.prediction_ts || (input.model && input.model.prediction_ts) || null };
  }
  /* the source's own representation, at its own precision (a decimal stays a decimal; a percentage is never re-rounded) */
  function sourcePrice(pr) {
    if (!pr || !pr.valid) return null;
    if (pr.precision === 'IMPLIED_PERCENT') return { implied: pr.implied_source };
    if (pr.precision === 'DECIMAL') return { decimal: pr.decimal };
    return pr.american;
  }
  function optionsFrom(ctx, input, books) {
    var quotes = ((input.market && input.market.quotes) || []).map(function (q, i) { return rd().normalizeQuote(q, i); });
    var live = rd().latestQuotes(quotes), out = [];
    var mine = books && books.length ? books.map(rd().bookKey) : null;
    live.forEach(function (q) {
      if (q.market_type !== 'spread' || !isNum(q.home_line) || q.pseudo) return;
      ['home', 'away'].forEach(function (s) {
        var pr = rd().sidePriceOf(q, s);
        if (!pr) return;
        var other = rd().sidePriceOf(q, s === 'home' ? 'away' : 'home');
        var o = evaluateOption(ctx, { side: s, line: s === 'home' ? q.home_line : -q.home_line, price: sourcePrice(pr),
          book: q.book, source: q.source, origin: q.origin === 'USER' ? 'USER' : 'LEDGER', quote_id: q.quote_id, observed_at: q.observed_at, provider_updated_at: q.provider_updated_at,
          alternate: q.alternate, other_price: sourcePrice(other), accessible: !mine || mine.indexOf(q.book_key) >= 0 });
        o._q = q;
        out.push(o);
      });
    });
    ((input.user_quotes) || []).forEach(function (u, i) {
      var q = rd().normalizeQuote(u, 'u' + i);
      ['home', 'away'].forEach(function (s) {
        var pr = rd().sidePriceOf(q, s); if (!pr) return;
        var o = evaluateOption(ctx, { side: s, line: s === 'home' ? q.home_line : -q.home_line, price: sourcePrice(pr), book: q.book, source: 'user',
          origin: 'USER', observed_at: q.observed_at || iso(ctx.now), alternate: q.alternate, accessible: true });
        out.push(o);
      });
    });
    return { options: out, live: live, quotes: quotes };
  }
  /* the anchor: the market's current line (the fresh consensus), where the calibrator was fitted */
  function withAnchor(ev, R) {
    var o = {}, k; for (k in (ev || {})) if (has(ev, k)) o[k] = ev[k];
    if (o.anchor_home_line == null && R && R.consensus && R.consensus.available && !R.consensus.stale && isNum(R.consensus.home_line)) {
      o.anchor_home_line = R.consensus.home_line;
      o.anchor_source = 'market consensus (' + R.consensus.method + ', ' + R.consensus.n_books + ' book' + (R.consensus.n_books === 1 ? '' : 's') + ', ' + R.consensus.as_of + ')';
    }
    return o;
  }
  function evRead(input, read, ev) {
    input = input || {}; ev = ev || {};
    var R = read || rd().read(input);
    var ctx = contextOf(input, withAnchor(ev, R)), P = ctx.policy;
    var books = ev.books || (input.view && input.view.mode === 'mine' ? input.view.books : null) || null;
    var O = ctx.model.available && ctx.curve ? optionsFrom(ctx, input, books) : { options: [], live: [], quotes: [] };
    var all = O.options;
    var usable = all.filter(function (o) { return o.priced && !o.problem && o.origin !== 'USER'; });
    var fresh = usable.filter(function (o) { return o.quote_fresh; });
    var accessible = fresh.filter(function (o) { return o.accessible; });
    var users = all.filter(function (o) { return o.origin === 'USER'; });
    var research = R && R.research_status ? R.research_status : { status: 'LIMITED_DATA', blocks_action: false, caps_at_research: true, verified: false, integrity_gate: 'NOT_REQUIRED', reason: 'no Read' };
    /* the selection: the best value among the reader's accessible fresh quotes (both sides), else the best fresh quote anywhere (context) */
    var ranked = accessible.slice().sort(rankValue);
    var cur = ranked[0] || null;
    var side = cur ? cur.side : (R && R.side) || null;
    var sideOpts = all.filter(function (o) { return o.side === side; });
    /* the market consensus option and the book-specific edge */
    var cons = R && R.consensus && R.consensus.available && !R.consensus.stale ? R.consensus : null;
    var consOpt = null;
    if (side && cons && ctx.model.available) {
      var cp = side === 'home' ? cons.price_home : cons.price_away, co = side === 'home' ? cons.price_away : cons.price_home;
      if (isNum(cp)) consOpt = evaluateOption(ctx, { side: side, line: side === 'home' ? cons.home_line : -cons.home_line, price: cp, book: 'consensus', source: cons.method, origin: 'CONSENSUS', observed_at: cons.as_of, other_price: isNum(co) ? co : null });
    }
    var edgeKind = edgeKindOf(ctx, cur, consOpt, R);
    /* the price curve: every accessible quote on the side (main + alternates), then the reference ladder */
    var curveRows = priceCurveRows(ctx, side, sideOpts.filter(function (o) { return o.priced && !o.problem; }), cur);
    var mains = sideOpts.filter(function (o) { return o.priced && !o.problem && o.is_main_line && o.quote_fresh && o.accessible && o.origin !== 'USER'; }).sort(rankValue);
    var alts = sideOpts.filter(function (o) { return o.priced && !o.problem && !o.is_main_line && o.quote_fresh && o.accessible; }).sort(rankValue);
    var safest = sideOpts.filter(function (o) { return o.priced && !o.problem && o.quote_fresh && o.accessible && o.origin !== 'USER'; })
      .sort(function (a, b) { var wa = isNum(a.p_win_calibrated) ? a.p_win_calibrated : a.p_win_raw, wb = isNum(b.p_win_calibrated) ? b.p_win_calibrated : b.p_win_raw; return (wb - wa) || rankValue(a, b); })[0] || null;
    var labels = { best_ev: cur ? cur.label : null, best_main_line: mains[0] ? mains[0].label : null, best_alt_value: alts[0] ? alts[0].label : null, safest_line: safest ? safest.label : null,
      note: 'SAFEST is the highest chance of winning, never the preferred line: value is decided by EV at the exact price.' };
    var altRows = alts.map(function (a) { var base = mains.filter(function (m) { return m.book_key === a.book_key; })[0] || mains[0] || null; return { option: stripOption(a), vs_main: base ? juice(ctx, base, a) : null }; });
    /* targets, circuit breaker, recheck, history */
    var targets = side && ctx.model.available ? priceTargets(ctx, side, cur) : null;
    var cb = circuitBreaker(ctx, cur, R);
    var rc = cur ? recheck(ctx, cur, O.quotes) : { status: 'NOT_APPLICABLE' };
    var prior = (ev.history || []).filter(function (s) { return s.side === side && s.selection_market !== 'moneyline'; }).sort(function (a, b) { return ms(a.decision_ts) - ms(b.decision_ts); });
    var firstEligible = prior.filter(function (s) { return s.policy_clears; })[0] || null;
    var initial = firstEligible ? { edge: firstEligible.probability_edge, ev: firstEligible.calibrated_ev, label: firstEligible.label, at: firstEligible.decision_ts, snapshot_id: firstEligible.snapshot_id } : null;
    if (!initial && side && R && R.price_is_gone && R.price_is_gone.initial && R.price_is_gone.initial.clears && ctx.calibration.usable) {
      /* the first number is judged with the market AS IT STOOD THEN: the calibrator is anchored at the opener's own line */
      var io = R.price_is_gone.initial, octx = contextOf(input, withAnchor(Object.assign({}, ev, { anchor_home_line: side === 'home' ? io.line : -io.line, anchor_source: 'the opener (the market at the time)' }), null));
      octx.calibration = calFor(octx, 'OPEN');
      var iOpt = evaluateOption(octx, { side: side, line: io.line, price: isNum(io.price) ? io.price : P.reference_price, origin: 'OPEN', book: 'open', observed_at: io.at || null });
      if (iOpt.policy_clears) initial = { edge: iOpt.probability_edge, ev: iOpt.calibrated_ev, label: iOpt.label + ' (the first number, judged against the market at the open)', at: io.at || null };
    }
    var decay = edgeDecay(initial, cur ? { edge: isNum(cur.probability_edge) ? cur.probability_edge : null, ev: cur.calibrated_ev, label: cur.label } : null);
    var D0 = decide(ctx, { read: R, research: research, cur: cur, all: all, fresh: fresh, accessible: accessible, usable: usable, targets: targets, cb: cb, rc: rc, initial: initial, side: side });
    var out = {
      schema: 'edgedesk_ev_read_v1', engine: VERSION, game_id: ctx.game.game_id, generated_at: iso(ctx.now), home: ctx.game.home, away: ctx.game.away, kickoff: ctx.game.kickoff,
      model_version: ctx.model.model_version, prediction_ts: ctx.prediction_ts,
      distribution_artifact_id: ctx.curve ? 'curve_' + hash([ctx.model.model_version, ctx.curve.lo, ctx.curve.step, ctx.curve.win, ctx.curve.push]) : null,
      calibrator_version: ctx.calibration.version, calibration: { key: ctx.calibration.key, status: ctx.calibration.status, usable: ctx.calibration.usable,
        method: ctx.calibration.method, maturity: ctx.calibration.maturity, reason: ctx.calibration.reason, training_window: ctx.calibration.training_window || null, n: ctx.calibration.n,
        oof: ctx.calibration.oof || null },
      decision_policy_version: P.version, policy_maturity: P.maturity, tooltip: TOOLTIP,
      calibration_anchor: ctx.calibration.usable ? (function () { var A = anchorOf(ctx, ctx.calibration); return A ? { home_line: A.home_line, source: A.source, raw_home_cover: A.raw_home_cover, calibrated_home_cover: A.calibrated_home_cover, delta_pts: A.delta_pts, text: A.text || null, problem: A.problem || null } : null; })() : null,
      fair_spread: isNum(ctx.model.home_margin) ? { home_margin: r(ctx.model.home_margin, 2), text: fairText(ctx.model.home_margin, ctx.game.home, ctx.game.away) } : null,
      market_consensus: cons ? { home_line: cons.home_line, n_books: cons.n_books, method: cons.method, as_of: cons.as_of, price_home: cons.price_home, price_away: cons.price_away } : null,
      side: side, side_team: side ? teamOf(ctx, side) : null,
      selected: cur ? stripOption(cur) : null,
      consensus_option: consOpt ? stripOption(consOpt) : null,
      research_status: research.status, research: { status: research.status, label: research.label, reason: research.reason, integrity_gate: research.integrity_gate, blocks_action: research.blocks_action, verified: research.verified },
      integrity_gate_pass: !research.blocks_action && !(R && R.integrity_status && R.integrity_status.quote_check_blocks) && (!cb.triggered || cb.verified === true),
      decision_status: D0.decision_status, policy_decision: D0.policy_decision, timing: D0.timing, decision_reason_code: D0.reason_code, decision_reason: D0.reason,
      blockers: D0.blockers, actionable: D0.actionable, decision_means: DECISION[D0.decision_status],
      target_price: targets && targets.target ? targets.target : null, bettable_to: targets, price_gone: D0.decision_status === 'PRICE_GONE',
      edge_decay: decay, edge_kind: edgeKind, circuit_breaker: cb, recheck: { status: rc.status, text: rc.text || null, requoted: rc.status === 'REQUOTED' ? stripOption(rc.option) : null },
      favorite_flip: favoriteFlip(ctx, R), labels: labels, main_vs_alt: { rows: altRows, captured: alts.length, note: labels.note },
      price_curve: curveRows, line_shopping: fresh.filter(function (o) { return o.side === side && o.is_main_line; }).sort(rankValue).map(function (o) { return { label: o.label, book: o.book, accessible: o.accessible, calibrated_ev: o.calibrated_ev, conservative_ev: o.conservative_ev, raw_model_ev: o.raw_model_ev }; }),
      user_quotes: users.map(stripOption),
      broader_market: usable.filter(function (o) { return !o.accessible && o.quote_fresh; }).sort(rankValue).slice(0, 5).map(function (o) { return { label: o.label, book: o.book, calibrated_ev: o.calibrated_ev, raw_model_ev: o.raw_model_ev, note: 'context only: not in your books' }; }),
      moneyline: moneylineOf(ctx, input),
      markets: Object.keys(MARKETS).map(function (k) { var s = marketSupport(k); return { type: k, id: s.id, label: s.label, status: s.status, reason: s.reason }; }),
      uncertainty: ctx._draws ? { samples: ctx._draws.S, layers: ctx._draws.layers, complete: ctx._draws.complete, conservative_quantile: P.conservative_quantile, interval: P.interval, tau_pts: r(ctx._draws.tau, 3) } : null,
      maturity: maturityOf(ctx),
      quote_freshness: all.filter(function (o) { return o.origin !== 'HYPOTHETICAL'; }).map(function (o) { return { label: o.label, book: o.book, source: o.source, origin: o.origin, captured_at: o.quote_ts, age_seconds: o.quote_age_seconds, ttl_minutes: o.ttl_minutes, ttl_basis: o.ttl_basis, freshness: o.freshness, checkpoint: o.market_checkpoint, line: o.line, odds: o.odds ? o.odds.american_display : null }; }),
      limits: { status: 'UNKNOWN', text: 'No book publishes its stake limit to EdgeDesk: LIMITED EXECUTION cannot be ruled out, and the EV is quoted per unit, not at unlimited scale.' },
      execution: { theoretical_ev: cur ? cur.calibrated_ev : null, execution_adjusted_ev: null, text: 'No commission, fee or measured slippage applies to a US fixed-odds quote on file; execution-adjusted EV is not estimated (never a hypothetical deduction).' },
      principle: 'EV is about ' + (cur ? cur.label + (cur.book ? ' at ' + cur.book : '') : 'an exact price') + '. At another number or another price the same football opinion has a different EV.'
    };
    out.headline = headlineOf(out);
    out.language = auditText(collect(out));
    return deepFreeze(out);
  }
  function fairText(margin, home, away) { if (!isNum(margin)) return null; if (Math.abs(margin) < 0.05) return 'Pick’em'; return (margin > 0 ? home : away) + ' -' + Math.abs(margin).toFixed(1); }
  function favoriteFlip(ctx, R) {
    var mh = R && R.market_consensus_spread ? R.market_consensus_spread.home_line : null, f = ctx.model.home_margin;
    var flip = isNum(mh) && isNum(f) && Math.abs(f) >= 0.5 && Math.abs(mh) >= 0.5 && Math.sign(f) !== Math.sign(-mh);
    return { flag: !!flip, text: flip ? 'FAVORITE FLIP: EdgeDesk favours ' + (f > 0 ? ctx.game.home : ctx.game.away) + '; the market favours ' + (mh < 0 ? ctx.game.home : ctx.game.away) + '. Enhanced integrity checks apply, and flips are tracked as their own validation group.' : null };
  }
  function edgeKindOf(ctx, cur, consOpt, R) {
    var out = { kind: 'NONE', model_vs_consensus_ev: null, book_specific_ev: null, model_vs_consensus_points: R && R.model_market_gap ? R.model_market_gap.points : null, text: null };
    if (!cur || !cur.priced) { out.text = 'No priced quote.'; return out; }
    var evCur = isNum(cur.calibrated_ev) ? cur.calibrated_ev : cur.raw_model_ev, basis = isNum(cur.calibrated_ev) ? 'calibrated' : 'raw (experimental)';
    if (!consOpt || !consOpt.priced) { out.text = 'No priced consensus to separate model edge from book edge.'; out.basis = basis; return out; }
    var evCons = isNum(consOpt.calibrated_ev) ? consOpt.calibrated_ev : consOpt.raw_model_ev;
    out.model_vs_consensus_ev = r(evCons); out.book_specific_ev = r(evCur - evCons); out.basis = basis;
    var eq = ctx.policy.juice.ev_equivalent;
    out.kind = evCons > 0 && evCur - evCons > eq ? 'BOTH' : (evCons > 0 ? 'MODEL_EDGE' : (evCur > 0 ? 'BOOK_SPECIFIC_PRICE_EDGE' : 'NONE'));
    out.text = { BOTH: 'BOTH: the football model already has ' + evText(evCons) + ' EV at the consensus price, and ' + (cur.book || 'this book') + '’s number adds ' + evText(evCur - evCons) + ' more.',
      MODEL_EDGE: 'MODEL EDGE: the EV (' + evText(evCons) + ' at the consensus) comes from EdgeDesk’s football price, not from one book.',
      BOOK_SPECIFIC_PRICE_EDGE: 'BOOK-SPECIFIC PRICE EDGE: at the consensus the EV is ' + evText(evCons) + '; ' + (cur.book || 'this book') + '’s number is what makes it ' + evText(evCur) + '. Check that the quote is current.',
      NONE: 'Neither the football price nor any book’s number produces positive EV (' + basis + ').' }[out.kind];
    return out;
  }
  function priceCurveRows(ctx, side, opts, cur) {
    if (!side) return { side: null, offered: [], ladder: [] };
    var P = ctx.policy, rows = opts.map(function (o) {
      return { kind: o.origin === 'USER' ? 'USER QUOTE' : (o.is_main_line ? 'MAIN' : 'ALTERNATE'), book: o.book, line: o.line, line_text: o.line_text, odds: o.odds ? o.odds.american_display : null,
        approximate_price: o.odds ? o.odds.approximate_american : false, cover: isNum(o.p_cover_calibrated) ? o.p_cover_calibrated : o.p_cover_raw, cover_raw: o.p_cover_raw,
        cover_calibrated: o.p_cover_calibrated, push: o.p_push_raw, win: isNum(o.p_win_calibrated) ? o.p_win_calibrated : o.p_win_raw, break_even: o.break_even_probability,
        break_even_unconditional: o.break_even_unconditional, model_edge: isNum(o.probability_edge) ? o.probability_edge : o.raw_probability_edge,
        ev: isNum(o.calibrated_ev) ? o.calibrated_ev : o.raw_model_ev, raw_ev: o.raw_model_ev, calibrated_ev: o.calibrated_ev, robust_ev: o.conservative_ev, prob_ev_positive: o.prob_ev_positive,
        basis: o.probability_basis, fresh: o.quote_fresh, freshness: o.freshness, accessible: o.accessible,
        read: o === cur ? 'BEST EV' : (o.policy_clears ? 'CLEARS' : o.grade) };
    });
    var ladder = [], center = cur ? cur.line : (isNum(ctx.model.home_margin) ? Math.round(fairLineForSide(ctx, side) * 2) / 2 : null), k;
    if (isNum(center)) for (k = -6; k <= 6; k++) {
      var h = hypothetical(ctx, side, center + k * 0.5, P.reference_price);
      if (h.problem) continue;
      ladder.push({ kind: 'REFERENCE', line: h.line, line_text: h.line_text, odds: P.reference_price, cover: isNum(h.p_cover_calibrated) ? h.p_cover_calibrated : h.p_cover_raw, push: h.p_push_raw,
        break_even: h.break_even_probability, model_edge: isNum(h.probability_edge) ? h.probability_edge : h.raw_probability_edge, ev: isNum(h.calibrated_ev) ? h.calibrated_ev : h.raw_model_ev,
        robust_ev: h.conservative_ev, prob_ev_positive: h.prob_ev_positive, basis: h.probability_basis, read: h.policy_clears ? 'CLEARS' : h.grade });
    }
    /* coherence: the same frozen distribution must give P(cover) monotone in the line */
    var sorted = rows.concat(ladder).slice().sort(function (a, b) { return a.line - b.line; }), coherent = true;
    for (k = 1; k < sorted.length; k++) if (isNum(sorted[k].win) && isNum(sorted[k - 1].win) && sorted[k].line > sorted[k - 1].line && sorted[k].win < sorted[k - 1].win - 1e-9) coherent = false;
    return { side: side, team: teamOf(ctx, side), offered: rows.sort(function (a, b) { return (b.line - a.line) || ((a.odds || 0) - (b.odds || 0)); }), ladder: ladder,
      coherent: coherent, sort_options: ['BEST_EV', 'BEST_MAIN', 'BEST_ALT', 'SAFEST'], default_sort: 'BEST_EV',
      note: 'Offered rows are quotes at their own price. Ladder rows are the reference price (' + priceText(P.reference_price) + ') at each half point — a reference, not an offer and never an assumption about a book.' };
  }
  function moneylineOf(ctx, input) {
    var M = input.market && input.market.moneyline, sup = marketSupport('moneyline'), out = { status: sup.status, reason: sup.reason, decides: false };
    if (!isNum(ctx.model.home_win_prob) || !M) { out.available = false; return out; }
    var ph = ctx.model.home_win_prob, cal = calibrationFor(ctx.artifact, 'cfb|moneyline|close', ctx.model.model_version);
    out.available = true; out.calibration = { status: cal.status, method: cal.method, usable: cal.usable };
    out.sides = ['home', 'away'].map(function (s) {
      var price = s === 'home' ? num(M.price_home) : num(M.price_away), odds = normalizeOdds(price), p = s === 'home' ? ph : 1 - ph;
      var pc = cal.usable ? (s === 'home' ? applyCalibrator(cal.map, ph) : 1 - applyCalibrator(cal.map, ph)) : null;
      if (!odds.valid) return { side: s, problem: 'no price' };
      var states = twoWayStates(p, 0, odds.decimal, { allow_push: true, void: true });
      return { side: s, team: teamOf(ctx, s), odds: odds.american_display, decimal: r(odds.decimal), p_win_raw: r(p), p_win_calibrated: r(pc), break_even: r(1 / odds.decimal),
        raw_model_ev: r(expectedValue(states)), calibrated_ev: isNum(pc) ? r(twoWayEv(pc, 0, odds.decimal)) : null, settlement: 'FULL_WIN / VOID (P 0: no ties) / FULL_LOSS' };
    });
    var dv = normalizeOdds(num(M.price_home)).valid && normalizeOdds(num(M.price_away)).valid ? DEVIG_METHODS.reduce(function (o, m) { var d = devig([normalizeOdds(num(M.price_home)).decimal, normalizeOdds(num(M.price_away)).decimal], m); o[m] = d.ok ? r(d.p[0]) : null; return o; }, {}) : null;
    out.market_benchmark_home = dv; out.book = M.book || null; out.observed_at = M.observed_at || null;
    out.note = 'RESEARCH: moneyline EV is shown, never decided on (tier RESEARCH).';
    return out;
  }
  function maturityOf(ctx) {
    var c = ctx.calibration;
    return [
      { item: 'Probability calibrator', status: c.usable ? (c.status === 'PROMOTED' ? 'PROMOTED · ' + (c.maturity || 'SHADOW') : 'IDENTITY VALIDATED · ' + (c.maturity || 'SHADOW')) : 'PENDING', note: c.usable ? c.method + ' (' + c.version + ')' : c.reason },
      { item: 'Robust EV', status: 'RESEARCH', note: 'bootstrap calibration + excess model disagreement; validated only by the prospective record' },
      { item: 'EV decision policy', status: ctx.policy.maturity, note: ctx.policy.version + ' (pre-registered); a policy BET is capped to RESEARCH ONLY until promotion' },
      { item: 'Timing (bet early / wait)', status: 'EXPERIMENTAL', note: 'graded by later prices and CLV, never by wins' },
      { item: 'Alternate-line selection', status: 'SHADOW', note: 'priced by the same curve; recorded and graded before any claim' },
      { item: 'Market de-vig benchmark', status: 'RESEARCH', note: 'displayed as a benchmark; never EdgeDesk’s probability' },
      { item: 'Staking', status: 'DISABLED', note: 'downstream of validated EV; no Kelly default' }
    ];
  }

  /* ============================================================ DECISION
     First rule that holds. Research status and decision status stay
     separate; every non-BET with apparent EV names its blockers. */
  function decide(ctx, s) {
    var P = ctx.policy, R = s.read, blockers = [], cur = s.cur;
    function blk(code, text) { blockers.push({ code: code, text: text }); }
    function res(status, code, text, timing, policyDecision) {
      return { decision_status: status, policy_decision: policyDecision || status, reason_code: code, reason: text, timing: timing || statusTiming(status), blockers: blockers, actionable: false };
    }
    if (!ctx.model.available) return res('NO_DECISION', 'MODEL_ARTIFACT_MISSING', 'No EdgeDesk projection for this game.');
    if (!ctx.curve) return res('NO_DECISION', 'MODEL_ARTIFACT_MISSING', 'The frozen probability curve is missing: nothing can be priced.');
    var cs = curveSane(ctx.curve);
    if (!cs.ok) return res('NO_DECISION', 'DISTRIBUTION_FAULT', 'The stored curve is not a coherent distribution: ' + cs.why + '.');
    if (s.cb && s.cb.checks.some(function (c) { return c.id === 'SIGN_ORIENTATION' && c.status === 'FAIL'; })) return res('NO_DECISION', 'SIGN_ORIENTATION', 'SIGN / ORIENTATION: the market number looks flipped relative to the model.');
    var rs = s.research;
    var apparent = cur && ((isNum(cur.calibrated_ev) && cur.calibrated_ev > 0) || (isNum(cur.raw_model_ev) && cur.raw_model_ev > 0));
    if (rs.integrity_gate === 'DATA_FAULT') { blk('DATA_FAULT', 'DATA FAULT: ' + rs.reason); return res('NO_DECISION', 'DATA_FAULT', 'DATA FAULT: ' + stop(rs.reason) + '. EV is research context only.', 'RESEARCH'); }
    if (rs.blocks_action) { blk(rs.status, rs.label + ': ' + rs.reason); return res('NO_DECISION', rs.status, rs.label + ': ' + stop(rs.reason) + '. ' + (apparent ? 'The EV shown is research context, never actionable before the gap is verified.' : 'Not priced as actionable.'), 'RESEARCH'); }
    if (R && R.integrity_status && R.integrity_status.quote_check_blocks) { blk('MARKET_CHECK', 'two current numbers for one book disagree by a point or more'); return res('NO_DECISION', 'MARKET_CHECK', 'MARKET CHECK: two current numbers for the same book disagree. Nothing is actionable until one is confirmed.'); }
    if (!s.usable.length) return res('NO_DECISION', 'NO_PRICE', 'No priced quote on file.');
    if (!s.fresh.length) { blk('STALE_QUOTE', 'every quote is older than its TTL'); return res('NO_DECISION', 'STALE_QUOTE', 'STALE QUOTE / MARKET CHECK: every priced quote is older than its time-to-live. No EV is actionable off a price that may no longer exist.'); }
    if (!cur) { blk('NO_ACCESSIBLE_PRICE', 'no fresh quote at your books'); return res('NO_DECISION', 'NO_ACCESSIBLE_PRICE', 'No fresh priced quote at your books. The broader market is shown as context.'); }
    if (!ctx.calibration.usable || !isNum(cur.p_cover_calibrated)) {
      if (ctx.calibration.usable) { ctx.calibration = Object.assign({}, ctx.calibration, { status: 'UNANCHORED', reason: cur.calibration_unavailable || 'no current market line to evaluate the calibrator at' }); }
      blk('CALIBRATION_UNAVAILABLE', 'CALIBRATION ' + ctx.calibration.status + ': ' + stop(ctx.calibration.reason));
      if (apparent) blk('RAW_EV_EXPERIMENTAL', 'raw model EV ' + evText(cur.raw_model_ev) + ' is experimental research context');
      return res('NO_DECISION', 'CALIBRATION_UNAVAILABLE', 'NO DECISION — the required calibration is unavailable (' + stop(ctx.calibration.reason) + '). Raw EV ' + evText(cur.raw_model_ev) + ' at ' + cur.label + ' is experimental research context, never a validated EV.', 'RESEARCH');
    }
    var limited = rs.caps_at_research || rs.status === 'LIMITED_DATA';
    var lowRel = R && isNum(R.reliability) && R.reliability < 60;
    if (cur.policy_clears) {
      if (limited || lowRel) { blk(lowRel ? 'LOW_RELIABILITY' : 'LIMITED_DATA', stop(rs.reason || 'reliability under 60')); return res('RESEARCH_ONLY', lowRel ? 'LOW_RELIABILITY' : 'LIMITED_DATA', 'RESEARCH ONLY — the price clears the EV policy, but the inputs are too limited for an actionable read: ' + stop(rs.reason) + '.', 'RESEARCH'); }
      if (s.cb.triggered && !s.cb.verified) { blk('EXTREME_EV_REVIEW', s.cb.text); return res('RESEARCH_ONLY', 'EXTREME_EV_REVIEW', s.cb.text, 'RESEARCH'); }
      var qb = R && R.qb_status ? R.qb_status : { resolved: true, unresolved: [] };
      if (!qb.resolved) { blk('QB_UNRESOLVED', qb.unresolved.join('; ')); return res('WAIT', 'INFORMATION_PENDING', 'WAIT — information pending: ' + stop(qb.unresolved.join('; ')) + '. The price clears (' + evText(cur.calibrated_ev) + ' calibrated EV), but the thesis depends on who starts.', 'WAIT'); }
      if (s.rc.status === 'UNAVAILABLE' || s.rc.status === 'STALE') { blk('PRICE_UNAVAILABLE', s.rc.text); return res('NO_DECISION', 'PRICE_UNAVAILABLE', s.rc.text); }
      if (s.rc.status === 'REQUOTED' && !(s.rc.option && s.rc.option.policy_clears)) { blk('REQUOTED', s.rc.text); return res('PASS', 'REQUOTED', s.rc.text + ' The new price does not clear the policy.'); }
      if (!cur.within_price_limit) { blk('PRICE_LIMIT', 'the price is longer than the policy’s ' + priceText(P.max_price) + ' limit'); return res('RESEARCH_ONLY', 'PRICE_LIMIT', 'RESEARCH ONLY — the price is outside the policy’s ' + priceText(P.max_price) + ' limit.', 'RESEARCH'); }
      if (cur.key_number_unvalidated) { blk('KEY_NUMBER_MASS_UNVALIDATED', 'the price crosses ' + cur.key_numbers_from_market.map(function (k) { return k.key; }).join(', ') + ' from the market line, and the distribution’s key-number mass is not validated'); return res('RESEARCH_ONLY', 'KEY_NUMBER_MASS_UNVALIDATED', 'RESEARCH ONLY — ' + cur.label + ' crosses a key number from the market line (' + cur.key_numbers_from_market.map(function (k) { return k.key; }).join(', ') + '), and the audit found the distribution under-states key-number mass. ' + (ctx.key_numbers && ctx.key_numbers.finding ? ctx.key_numbers.finding.split('. Cause')[0] + '.' : ''), 'RESEARCH'); }
      if (cur.origin === 'USER') { blk('USER_QUOTE', 'a USER QUOTE is evaluated, never certified'); return res('RESEARCH_ONLY', 'USER_QUOTE', 'RESEARCH ONLY — a USER QUOTE is evaluated with the same policy but never certified.', 'RESEARCH'); }
      /* timing: a measured reason the number may not last */
      var urg = [], mv = R && R.market_movement_summary;
      if (mv && mv.direction === 'TOWARD') urg.push({ code: 'MARKET_TOWARD', text: mv.text });
      var kc = keyCrossed(ctx, cur.side, cur.line - 0.5, cur.line).filter(function (k) { return k.is_key_number; });
      if (kc.length) urg.push({ code: 'KEY_NUMBER_AT_RISK', text: 'Losing half a point from ' + lineText(cur.line) + ' crosses ' + kc[0].key + ' (' + pct(kc[0].game_mass, 1) + ' of this game lands exactly there).' });
      var pd = urg.length ? 'BET_EARLY' : 'BET';
      /* the promotion ladder and the governed betting switch: a SHADOW policy never shows a bet */
      if (P.maturity !== 'PRODUCTION' || !P.betting_enabled) {
        blk('EV_POLICY_' + P.maturity, 'the EV policy is in ' + P.maturity + (P.betting_enabled ? '' : ' and betting is disabled') + ': the policy decision (' + pd.replace('_', ' ') + ') is recorded for validation, not shown as a bet');
        var r0 = res('RESEARCH_ONLY', 'POLICY_' + pd, 'RESEARCH ONLY — the policy clears ' + cur.label + (cur.book ? ' at ' + cur.book : '') + ' (calibrated EV ' + evText(cur.calibrated_ev) + ', robust ' + evText(cur.conservative_ev) + ', Pr(EV>0) ' + pct(cur.prob_ev_positive, 0) + '), but the EV policy is in ' + P.maturity + ': its ' + pd.replace('_', ' ') + ' is recorded for validation, not shown as a bet.', pd === 'BET_EARLY' ? 'BET_EARLY' : 'BET', pd);
        r0.urgency = urg; return r0;
      }
      var fin = res(pd, pd, (pd === 'BET_EARLY' ? 'BET EARLY — ' + urg.map(function (x) { return x.text; }).join(' ') : 'BET — the policy clears ' + cur.label + '. No measured reason to hurry.'), pd, pd);
      fin.actionable = true; fin.urgency = urg;
      return fin;
    }
    /* the price does not clear */
    blk('PRICE', 'at ' + cur.label + ': calibrated cover ' + pct(cur.p_cover_calibrated, 1) + ' vs break-even ' + pct(cur.break_even_probability, 1) + ', calibrated EV ' + evText(cur.calibrated_ev) + ', robust ' + evText(cur.conservative_ev) + ', Pr(EV>0) ' + pct(cur.prob_ev_positive, 0));
    if (isNum(cur.raw_model_ev) && cur.raw_model_ev > 0 && !(cur.calibrated_ev > 0)) blk('RAW_EV_NOT_CALIBRATED', 'raw EV ' + evText(cur.raw_model_ev) + ' does not survive calibration (' + evText(cur.calibrated_ev) + ')');
    if (rs.status === 'VERIFIED_MAJOR_DISAGREEMENT') blk('VERIFIED_MAJOR_IS_NOT_A_BET', 'a verified major disagreement still needs the price to clear');
    if (s.initial && isNum(s.initial.edge) && s.initial.edge > 0) return res('PRICE_GONE', 'PRICE_GONE', 'PRICE GONE — ' + s.initial.label + ' cleared the policy (' + ppText(s.initial.edge) + '); ' + cur.label + ' does not. The earlier read stays frozen as it was.');
    var T = s.targets && s.targets.target;
    /* a reachable target for WAITING: (1) a number inside ordinary open-to-close movement that would STILL clear if the whole market moved
       there (the calibrator re-anchors at the market line, so a move the model has no view on carries the calibrated probability with it),
       or (2) this number at a price no better than the standard reference. Anything else is a SHOPPING target: a book off the market. */
    var gapPts = R && R.model_market_gap ? R.model_market_gap.points : null;
    if (T && !(isNum(gapPts) && gapPts >= P.timing.min_gap_for_wait - 1e-9)) {
      blk('NO_DISAGREEMENT_TO_WAIT_ON', 'EdgeDesk and the market are ' + (isNum(gapPts) ? gapPts.toFixed(1) + ' pts' : 'not measurably') + ' apart (a wait needs ' + P.timing.min_gap_for_wait + '+): there is no football reason to expect a better number');
      T = null;
    }
    if (T) {
      var lineOk = false;
      if (isNum(T.line) && isNum(T.distance_pts) && T.distance_pts <= P.timing.typical_move_pts + 1e-9) {
        var mctx = Object.assign({}, ctx, { anchor_home_line: cur.side === 'home' ? T.line : -T.line, anchor_source: 'the market, moved to the target', _anchor: null, _deltas: null, _anchored: null, _dists: null, calibrations: {} });
        var moved = evaluateOption(mctx, { side: cur.side, line: T.line, price: cur.odds.american, origin: 'HYPOTHETICAL', book: cur.book });
        lineOk = !!moved.policy_clears;
        if (!lineOk) blk('TARGET_MOVES_WITH_MARKET', 'a book offering ' + teamOf(ctx, cur.side) + ' ' + lineText(T.line) + ' while the market stays at ' + lineText(cur.market_line_for_side) + ' would clear, but if the whole market moves there the calibrated probability moves with it (calibrated EV ' + evText(moved.calibrated_ev) + ')');
      }
      var priceOk = isNum(T.price) && dec().americanToPayout(T.price) <= dec().americanToPayout(P.reference_price) + 1e-12;
      if (lineOk || priceOk) return res('WAIT', 'TARGET_PRICE', 'WAIT — ' + T.text + '. ' + (lineOk ? 'The target is ' + pts(T.distance_pts).toLowerCase() + ' away, inside ordinary open-to-close movement (' + P.timing.typical_move_pts + ' pts), and still clears if the market moves there' : 'The number is fine; the price is not: the target is no better than the standard ' + priceText(P.reference_price)) + '. Not a forecast that it arrives.', 'WAIT');
    }
    return res('PASS', isNum(cur.calibrated_ev) && cur.calibrated_ev > 0 ? 'ROBUST_EV_FAILS' : 'NEGATIVE_EV', 'PASS — at ' + cur.label + ' the calibrated EV is ' + evText(cur.calibrated_ev) + ' (robust ' + evText(cur.conservative_ev) + ', Pr(EV>0) ' + pct(cur.prob_ev_positive, 0) + ')'
      + (T ? '. SHOPPING TARGET: ' + T.text.replace(/^CURRENT .*? → TARGET /, '') + ' would clear at one book while the market stays where it is — not a reason to wait' : '') + '.');
  }
  function statusTiming(s) { return { BET_EARLY: 'BET_EARLY', BET: 'BET', WAIT: 'WAIT', PASS: 'PASS', PRICE_GONE: 'PASS', RESEARCH_ONLY: 'RESEARCH', NO_DECISION: 'NO_DECISION' }[s] || 'NO_DECISION'; }
  function stop(t) { return String(t == null ? '' : t).replace(/[\s.]+$/, ''); }

  function headlineOf(o) {
    var s = o.selected;
    return {
      exact_price: s ? s.label + (s.book ? ' · ' + s.book : '') : null,
      fair_line: o.fair_spread ? o.fair_spread.text : null,
      calibrated_cover: s && isNum(s.p_cover_calibrated) ? pct(s.p_cover_calibrated, 1) : (s ? 'PENDING (raw ' + pct(s.p_cover_raw, 1) + ')' : null),
      break_even: s ? pct(s.break_even_probability, 1) + (s.p_push_raw > 0 ? ' (' + pct(s.break_even_unconditional, 1) + ' of all outcomes; push ' + pct(s.p_push_raw, 1) + ')' : '') : null,
      probability_edge: s ? (isNum(s.probability_edge) ? ppText(s.probability_edge) : 'PENDING (raw ' + ppText(s.raw_probability_edge) + ')') : null,
      calibrated_ev: s ? (isNum(s.calibrated_ev) ? evText(s.calibrated_ev) : 'PENDING') : null,
      raw_ev: s ? evText(s.raw_model_ev) + ' (raw, experimental)' : null,
      robust_ev: s && isNum(s.conservative_ev) ? evText(s.conservative_ev) + (s.probability_basis === 'RAW' ? ' (raw basis)' : '') : null,
      prob_ev_positive: s && isNum(s.prob_ev_positive) ? pct(s.prob_ev_positive, 0) : null,
      decision: o.decision_status.replace(/_/g, ' '), timing: o.timing.replace(/_/g, ' '),
      bettable_to: o.bettable_to ? o.bettable_to.text : null, research_status: o.research.label || o.research_status
    };
  }
  function collect(o) {
    return [o.decision_reason, o.principle, o.edge_kind && o.edge_kind.text, o.edge_decay && o.edge_decay.text, o.circuit_breaker && o.circuit_breaker.text, o.favorite_flip.text]
      .concat(o.blockers.map(function (b) { return b.text; })).concat(o.main_vs_alt.rows.map(function (x) { return x.vs_main ? x.vs_main.why + ' ' + x.vs_main.explanation.join(' ') : ''; })).filter(Boolean).join(' \n ');
  }
  function auditText(text) { var p = []; BANNED.forEach(function (re) { if (re.test(text)) p.push('forbidden wording: ' + re); }); return { ok: !p.length, problems: p }; }

  /* ======================================================== INTERACTIONS
     All recompute from the same stored input: only the quote changes, the
     football model is never re-run. */
  function whatIf(input, spec, ev) {
    var ctx = contextOf(input, withAnchor(ev, rd().read(input)));
    var o = evaluateOption(ctx, { side: spec.side, line: spec.line, price: spec.price == null ? null : spec.price, origin: 'HYPOTHETICAL', book: spec.book || null });
    if (!o.priced) return { ok: false, problem: o.problem || 'a what-if needs a line AND a price (e.g. +5.5 −110)', option: stripOption(o) };
    var t = priceTargets(ctx, spec.side, o);
    var status = o.problem ? 'NOT PRICED' : (!ctx.calibration.usable ? 'NO DECISION (calibration pending) — raw EV ' + evText(o.raw_model_ev) : (o.policy_clears ? 'CLEARS THE POLICY' : (isNum(o.calibrated_ev) && o.calibrated_ev > 0 ? 'POSITIVE EV, BELOW THE ROBUST THRESHOLD' : 'PASS')));
    /* two different questions, both answered: one book offers this price while the market stays put
       (the calibrator stays anchored at the market line), or the whole market moves to this number
       (the calibrator re-anchors there) — under a map that discards the model's view they differ */
    var moved = null;
    if (!o.problem && ctx.calibration.usable) {
      var mctx = contextOf(input, Object.assign({}, ev || {}, { anchor_home_line: spec.side === 'home' ? spec.line : -spec.line, anchor_source: 'the market, moved to the what-if line' }));
      var mo = evaluateOption(mctx, { side: spec.side, line: spec.line, price: spec.price, origin: 'HYPOTHETICAL', book: spec.book || null });
      moved = { label: mo.label, p_cover_calibrated: mo.p_cover_calibrated, calibrated_ev: mo.calibrated_ev, conservative_ev: mo.conservative_ev, prob_ev_positive: mo.prob_ev_positive, policy_clears: mo.policy_clears,
        text: 'If the whole market moves to ' + lineText(spec.line) + ': calibrated cover ' + pct(mo.p_cover_calibrated, 1) + ', EV ' + evText(mo.calibrated_ev) + ' — ' + (mo.policy_clears ? 'clears' : 'does not clear') + '.' };
    }
    return { ok: !o.problem, option: stripOption(o), status: status, bettable_to: t, if_market_moves: moved,
      text: o.problem ? o.problem : o.label + ': cover ' + pct(isNum(o.p_cover_calibrated) ? o.p_cover_calibrated : o.p_cover_raw, 1) + (isNum(o.p_cover_calibrated) ? '' : ' raw') + ', push ' + pct(o.p_push_raw, 1)
        + ', break-even ' + pct(o.break_even_probability, 1) + ', EV ' + evText(isNum(o.calibrated_ev) ? o.calibrated_ev : o.raw_model_ev) + ', robust ' + evText(o.conservative_ev) + ' — ' + status + '.',
      note: 'Only the quote changed: the football model was not re-run, and a hypothetical price is never a certified bet.' };
  }
  function manual(input, text, ev) {
    var p = typeof text === 'string' ? rd().parseQuoteText(text, input.game) : text;
    if (!p || !p.ok) return { ok: false, problem: p ? p.problem : 'no quote' };
    var side = p.side || input.default_side || null;
    if (!side) return { ok: false, problem: 'name the team (' + input.game.home + ' or ' + input.game.away + ')' };
    if (!p.price || !p.price.valid) return { ok: false, problem: 'a line without a price is not an executable quote: add the odds (e.g. ' + (side === 'home' ? input.game.home : input.game.away) + ' ' + lineText(p.line) + ' -110)' };
    var ctx = contextOf(input, withAnchor(ev, rd().read(input)));
    var o = evaluateOption(ctx, { side: side, line: p.line, price: p.price.precision === 'IMPLIED_PERCENT' ? { implied: p.price.implied_source } : p.price.american, book: p.book, source: 'user', origin: 'USER', observed_at: iso(ctx.now) });
    return { ok: !o.problem, source_tag: 'USER QUOTE', option: stripOption(o), bettable_to: priceTargets(ctx, side, o),
      read: o.problem ? o.problem : (!ctx.calibration.usable ? 'EDGEDESK READ: raw EV ' + evText(o.raw_model_ev) + ' at ' + o.label + ' — experimental (calibration pending)' : 'EDGEDESK READ: ' + o.label + ' — calibrated EV ' + evText(o.calibrated_ev) + ', robust ' + evText(o.conservative_ev) + ', Pr(EV>0) ' + pct(o.prob_ev_positive, 0) + (o.policy_clears ? ' — clears the policy (a USER QUOTE is never certified)' : ' — does not clear the policy')),
      note: 'A USER QUOTE is priced with EdgeDesk’s distribution and the same policy. It never enters the consensus and is never certified.' };
  }
  function compareLines(input, specA, specB, ev) {
    var ctx = contextOf(input, withAnchor(ev, rd().read(input)));
    var a = evaluateOption(ctx, Object.assign({ origin: 'HYPOTHETICAL' }, specA)), b = evaluateOption(ctx, Object.assign({ origin: 'HYPOTHETICAL' }, specB));
    return juice(ctx, a, b);
  }

  /* ============================================================ SNAPSHOT
     The canonical game_ev_snapshot. Immutable, deterministic id. A
     production EV is invalid without its P0 identifiers (pack §2). */
  var P0_REQUIRED = ['game_id', 'selection_id', 'market_type', 'line_value', 'american_odds', 'decimal_odds', 'book_id', 'quote_ts', 'prediction_ts', 'model_version',
    'calibrator_version', 'settlement_rules', 'decision_policy_version', 'quote_id'];
  function snapshot(o, extra) {
    extra = extra || {};
    var s = o.selected || {};
    var row = {
      schema: SCHEMA, engine: VERSION,
      game_id: o.game_id, sport: 'cfb', market_type: s.market_type || null, selection_id: s.selection_id || null, selection_market: s.market_type || null,
      side: o.side, team: o.side_team, label: s.label || null, home: o.home, away: o.away,
      prediction_ts: extra.prediction_ts || o.prediction_ts || null, quote_ts: s.quote_ts || null, decision_ts: o.generated_at, kickoff_ts: o.kickoff,
      model_version: o.model_version, calibrator_version: o.calibrator_version, calibration_status: o.calibration.status, calibration_method: o.calibration.method,
      decision_policy_version: o.decision_policy_version, policy_maturity: o.policy_maturity,
      book_id: s.book || null, quote_id: s.quote_id || null, source: s.source || null, origin: s.origin || null, market_checkpoint: s.market_checkpoint || null,
      line_value: isNum(s.line) ? s.line : null, american_odds: s.odds ? s.odds.american : null, american_display: s.odds ? s.odds.american_display : null,
      decimal_odds: s.odds ? s.odds.decimal : null, raw_implied_probability: s.odds ? s.odds.implied_raw : null, odds_precision: s.odds ? s.odds.precision : null,
      quote_age_seconds: s.quote_age_seconds != null ? s.quote_age_seconds : null, quote_fresh: !!s.quote_fresh, ttl_minutes: s.ttl_minutes || null,
      settlement_rules: s.settlement ? s.settlement.structure : null,
      pure_fair_line: s.fair_line_for_side != null ? s.fair_line_for_side : null, pure_margin_mean: o.fair_spread ? o.fair_spread.home_margin : null,
      distribution_artifact_id: extra.distribution_artifact_id || o.distribution_artifact_id || null, price_curve_id: o.price_curve ? 'pc_' + hash(o.price_curve.offered.concat(o.price_curve.ladder).map(function (x) { return [x.kind, x.book, x.line, x.odds, x.ev]; })) : null,
      p_cover_raw: s.p_cover_raw != null ? s.p_cover_raw : null, p_win_raw: s.p_win_raw != null ? s.p_win_raw : null, p_push_raw: s.p_push_raw != null ? s.p_push_raw : null, p_loss_raw: s.p_loss_raw != null ? s.p_loss_raw : null,
      p_cover_calibrated: s.p_cover_calibrated != null ? s.p_cover_calibrated : null, p_win_calibrated: s.p_win_calibrated != null ? s.p_win_calibrated : null,
      p_push_calibrated: s.p_push_calibrated != null ? s.p_push_calibrated : null, p_loss_calibrated: s.p_loss_calibrated != null ? s.p_loss_calibrated : null,
      break_even_probability: s.break_even_probability != null ? s.break_even_probability : null, break_even_unconditional: s.break_even_unconditional != null ? s.break_even_unconditional : null,
      probability_edge: s.probability_edge != null ? s.probability_edge : null, raw_probability_edge: s.raw_probability_edge != null ? s.raw_probability_edge : null,
      raw_model_ev: s.raw_model_ev != null ? s.raw_model_ev : null, calibrated_ev: s.calibrated_ev != null ? s.calibrated_ev : null,
      conservative_ev: s.conservative_ev != null ? s.conservative_ev : null, ev_ci_low: s.ev_ci_low != null ? s.ev_ci_low : null, ev_ci_high: s.ev_ci_high != null ? s.ev_ci_high : null,
      prob_ev_positive: s.prob_ev_positive != null ? s.prob_ev_positive : null, ev_roi_pct: s.ev_roi_pct != null ? s.ev_roi_pct : null,
      market_fair_probability: s.market_benchmark ? s.market_benchmark.value : null, devig_method: s.market_benchmark ? s.market_benchmark.display_method : null,
      consensus_line: o.market_consensus ? o.market_consensus.home_line : null, book_count_same_market: o.market_consensus ? o.market_consensus.n_books : null,
      is_main_line: s.is_main_line != null ? s.is_main_line : null,
      research_status: o.research_status, integrity_gate_pass: o.integrity_gate_pass, favorite_flip: o.favorite_flip.flag,
      extreme_level: o.circuit_breaker.level, policy_clears: !!s.policy_clears, raw_clears: !!s.raw_clears,
      decision_status: o.decision_status, policy_decision: o.policy_decision, timing_status: o.timing, decision_reason_code: o.decision_reason_code, actionable: o.actionable,
      blockers: o.blockers.map(function (b) { return b.code; }),
      bettable_to_line: o.bettable_to && o.bettable_to.bettable_to ? o.bettable_to.bettable_to.line_at_current_price : null,
      bettable_to_odds: o.bettable_to && o.bettable_to.bettable_to ? o.bettable_to.bettable_to.price_at_current_line : null,
      target_line: o.target_price ? o.target_price.line : null, target_odds: o.target_price ? o.target_price.price : null,
      price_gone: o.price_gone, edge_kind: o.edge_kind ? o.edge_kind.kind : null,
      initial_probability_edge: o.edge_decay ? o.edge_decay.initial_probability_edge : null, edge_decay_pct: o.edge_decay ? o.edge_decay.decay_pct : null, edge_decay_state: o.edge_decay ? o.edge_decay.state : null,
      best_ev: o.labels.best_ev, best_main_line: o.labels.best_main_line, best_alt_value: o.labels.best_alt_value, safest_line: o.labels.safest_line,
      alt_rows: o.main_vs_alt.rows.map(function (x) { return { label: x.option.label, book: x.option.book, line: x.option.line, odds: x.option.odds ? x.option.odds.american_display : null, calibrated_ev: x.option.calibrated_ev, raw_model_ev: x.option.raw_model_ev, verdict: x.vs_main ? x.vs_main.verdict : null }; }),
      week_id: extra.week_id || null, season: extra.season || null, official: false
    };
    row.snapshot_id = 'edev_' + hash([row.game_id, row.selection_id, row.model_version, row.calibrator_version, row.decision_policy_version, row.book_id, row.quote_id, row.line_value, row.american_odds, row.decision_status, row.policy_decision, row.research_status]);
    var v = validateSnapshot(row);
    row.production_grade = v.ok; row.missing_fields = v.missing;
    return deepFreeze(row);
  }
  function validateSnapshot(row) {
    var missing = P0_REQUIRED.filter(function (k) { return row[k] === null || row[k] === undefined || row[k] === ''; });
    /* an identity calibrator carries no version only if the artifact names it; a pending calibration is never production-grade */
    return { ok: missing.length === 0 && (row.calibration_status === 'PROMOTED' || row.calibration_status === 'IDENTITY_VALIDATED'), missing: missing };
  }
  var RECORDABLE = ['BET_EARLY', 'BET', 'WAIT', 'PASS', 'PRICE_GONE', 'RESEARCH_ONLY', 'NO_DECISION'];
  function shouldRecord(o) {
    if (!o || !o.selected || RECORDABLE.indexOf(o.decision_status) < 0) return false;
    /* a NO DECISION with a price is recorded (it is what the reader saw); one without a price is not a read */
    return !!(o.selected.priced && !o.selected.problem);
  }

  /* ============================================================= GRADING
     Against the close and the final — at the recorded line and price, never a
     better historical line. g: { close_home_line, close_price_home,
     close_price_away, final_margin, later_quotes: [{home_line, price_home, price_away, observed_at, book}] } */
  function grade(row, g) {
    g = g || {};
    var out = { snapshot_id: row.snapshot_id, game_id: row.game_id, decision_status: row.decision_status, policy_decision: row.policy_decision, graded: false };
    if (!row.side || !isNum(row.line_value)) { out.reason = 'no side or line recorded'; return out; }
    var sgn = row.side === 'home' ? 1 : -1;
    var closeSide = isNum(num(g.close_home_line)) ? sgn * num(g.close_home_line) : null;
    out.close_line = closeSide;
    out.clv_points = isNum(closeSide) ? r(row.line_value - closeSide, 2) : null;           /* + = the bettor got the better line */
    var cp = row.side === 'home' ? num(g.close_price_home) : num(g.close_price_away);
    out.close_price = isNum(cp) ? cp : null;
    if (isNum(closeSide) && Math.abs(closeSide - row.line_value) < 1e-9 && isNum(cp) && isNum(row.decimal_odds)) {
      out.clv_probability = r(breakEven(americanToDecimal(cp), 0).conditional_nonpush - 1 / row.decimal_odds, 6);   /* F25: + = the entry price was better */
    } else out.clv_probability = null;
    out.beat_close = isNum(out.clv_points) ? (out.clv_points > 0 || (out.clv_points === 0 && isNum(out.clv_probability) && out.clv_probability > 0)) : null;
    var later = (g.later_quotes || []).filter(function (q) { return ms(q.observed_at) > ms(row.decision_ts) && (!row.kickoff_ts || ms(q.observed_at) < ms(row.kickoff_ts)) && isNum(num(q.home_line)); });
    var laterSide = later.map(function (q) { return { line: sgn * num(q.home_line), price: row.side === 'home' ? num(q.price_home) : num(q.price_away), at: q.observed_at }; });
    var best = laterSide.slice().sort(function (a, b) { return (b.line - a.line) || ((isNum(b.price) ? americanToDecimal(b.price) : 0) - (isNum(a.price) ? americanToDecimal(a.price) : 0)); })[0] || null;
    out.best_later = best;
    if (row.timing_status === 'BET_EARLY' || row.policy_decision === 'BET_EARLY' || row.policy_decision === 'BET') {
      out.later_deteriorated = isNum(closeSide) ? closeSide < row.line_value || (closeSide === row.line_value && isNum(out.clv_probability) && out.clv_probability > 0) : null;
    }
    if (row.decision_status === 'WAIT') {
      out.target_reached = best ? ((isNum(row.target_line) && best.line >= row.target_line - 1e-9) || (isNum(row.target_odds) && best.line >= row.line_value - 1e-9 && isNum(best.price) && americanToDecimal(best.price) >= americanToDecimal(row.target_odds) - 1e-9)) : false;
      out.wait_improvement_pts = best ? r(best.line - row.line_value, 2) : null;
      out.close_vs_wait_pts = isNum(closeSide) ? r(closeSide - row.line_value, 2) : null;
    }
    if (isNum(num(g.final_margin))) {
      var m = sgn * num(g.final_margin) + row.line_value;
      out.bet_result_state = m > 0 ? 'FULL_WIN' : (m < 0 ? 'FULL_LOSS' : 'PUSH');
      out.realized_net_units = isNum(row.decimal_odds) ? (out.bet_result_state === 'FULL_WIN' ? r(row.decimal_odds - 1, 6) : (out.bet_result_state === 'FULL_LOSS' ? -1 : 0)) : null;
      out.y_cover = out.bet_result_state === 'PUSH' ? null : (out.bet_result_state === 'FULL_WIN' ? 1 : 0);
      out.hypothetical = !(row.actionable);
      out.alt_results = (row.alt_rows || []).map(function (a) { var mm = sgn * num(g.final_margin) + a.line; var st = mm > 0 ? 'FULL_WIN' : (mm < 0 ? 'FULL_LOSS' : 'PUSH'); var d = isNum(a.odds) ? americanToDecimal(a.odds) : null;
        return { label: a.label, verdict: a.verdict, result: st, units: isNum(d) ? (st === 'FULL_WIN' ? r(d - 1, 6) : (st === 'FULL_LOSS' ? -1 : 0)) : null }; });
    }
    out.graded = isNum(out.clv_points) || !!out.bet_result_state;
    out.process_grade = !isNum(out.clv_points) ? 'NOT_GRADABLE' : (out.clv_points > 0.5 || (isNum(out.clv_probability) && out.clv_probability > 0.01) ? 'GOOD_PRICE' : (out.clv_points < -0.5 ? 'BAD_PRICE' : 'FAIR_PRICE'));
    /* process and outcome are separate: the four quadrants of pack §73 */
    out.quadrant = out.bet_result_state && isNum(out.clv_points) ? (out.clv_points > 0 ? 'POSITIVE_CLV_' : 'NON_POSITIVE_CLV_') + (out.bet_result_state === 'FULL_WIN' ? 'WON' : (out.bet_result_state === 'PUSH' ? 'PUSHED' : 'LOST')) : null;
    return out;
  }

  /* ============================================ THE LIVE VALIDATION DASHBOARD
     By version boundary; rates print only at n ≥ minN; realized ROI is never
     expected to equal stated EV at small n. */
  function scoreBlock(rows, key) {
    var xs = rows.filter(function (x) { return isNum(x.p) && (x.y === 0 || x.y === 1); });
    if (!xs.length) return { n: 0 };
    var brier = mean(xs.map(function (x) { return Math.pow(x.p - x.y, 2); }));
    var ll = mean(xs.map(function (x) { var p = clamp(x.p, 1e-6, 1 - 1e-6); return -(x.y * Math.log(p) + (1 - x.y) * Math.log(1 - p)); }));
    var fit = logisticSlope(xs);
    return { n: xs.length, brier: r(brier, 5), log_loss: r(ll, 5), slope: fit ? r(fit.b, 3) : null, intercept_citl: fit ? r(fit.citl, 3) : null, basis: key };
  }
  function logisticSlope(xs) {
    if (xs.length < 20) return null;
    var a = 0, b = 1, it, citl = 0;
    for (it = 0; it < 50; it++) {
      var g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
      xs.forEach(function (x) { var z = logit(x.p), p = sigm(a + b * z), w = p * (1 - p); g0 += x.y - p; g1 += (x.y - p) * z; h00 += w; h01 += w * z; h11 += w * z * z; });
      var det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break;
      var da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det; a += da; b += db;
      if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    for (it = 0; it < 50; it++) { var g = 0, h = 0; xs.forEach(function (x) { var p = sigm(citl + logit(x.p)); g += x.y - p; h += p * (1 - p); }); if (h < 1e-12) break; var d = g / h; citl += d; if (Math.abs(d) < 1e-10) break; }
    return { a: a, b: b, citl: citl };
  }
  var EV_BUCKETS = [[-Infinity, -0.05, '< −5%'], [-0.05, 0, '−5% to 0'], [0, 0.02, '0 to +2%'], [0.02, 0.05, '+2% to +5%'], [0.05, 0.10, '+5% to +10%'], [0.10, Infinity, '≥ +10%']];
  function validation(snaps, grades, opts) {
    opts = opts || {};
    var minN = opts.min_n || 30, byId = {};
    (grades || []).forEach(function (g) { byId[g.snapshot_id] = g; });
    function group(filter, label) {
      var S = (snaps || []).filter(filter), G = S.map(function (s) { return { s: s, g: byId[s.snapshot_id] }; });
      var graded = G.filter(function (x) { return x.g && x.g.bet_result_state; });
      var probs = graded.filter(function (x) { return x.g.y_cover === 0 || x.g.y_cover === 1; });
      var raw = scoreBlock(probs.map(function (x) { return { p: x.s.p_cover_raw, y: x.g.y_cover }; }), 'raw');
      var cal = scoreBlock(probs.filter(function (x) { return isNum(x.s.p_cover_calibrated); }).map(function (x) { return { p: x.s.p_cover_calibrated, y: x.g.y_cover }; }), 'calibrated');
      var clv = G.filter(function (x) { return x.g && isNum(x.g.clv_points); }).map(function (x) { return x.g.clv_points; });
      var buckets = EV_BUCKETS.map(function (b) {
        var inB = G.filter(function (x) { var e = isNum(x.s.calibrated_ev) ? x.s.calibrated_ev : null; return e != null && e >= b[0] && e < b[1]; });
        var u = inB.filter(function (x) { return x.g && isNum(x.g.realized_net_units); }).map(function (x) { return x.g.realized_net_units; });
        var c = inB.filter(function (x) { return x.g && isNum(x.g.clv_points); }).map(function (x) { return x.g.clv_points; });
        var roi = mean(u), sd = u.length > 1 ? Math.sqrt(u.reduce(function (a, v) { return a + (v - roi) * (v - roi); }, 0) / (u.length - 1)) : null;
        return { bucket: b[2], n: inB.length, avg_stated_ev: r(mean(inB.map(function (x) { return x.s.calibrated_ev; })), 4), n_settled: u.length,
          realized_roi: u.length >= minN ? r(roi, 4) : null, roi_ci95: u.length >= minN && isNum(sd) ? [r(roi - 1.96 * sd / Math.sqrt(u.length), 4), r(roi + 1.96 * sd / Math.sqrt(u.length), 4)] : null,
          avg_clv_pts: c.length >= minN ? r(mean(c), 3) : null, positive_clv_rate: c.length >= minN ? r(c.filter(function (v) { return v > 0; }).length / c.length, 3) : null, rates_shown: u.length >= minN };
      });
      var shadowBets = G.filter(function (x) { return x.s.policy_decision === 'BET' || x.s.policy_decision === 'BET_EARLY'; }).sort(function (a, b) { return ms(a.s.decision_ts) - ms(b.s.decision_ts); });
      var path = 0, peak = 0, dd = 0;
      shadowBets.forEach(function (x) { if (x.g && isNum(x.g.realized_net_units)) { path += x.g.realized_net_units; peak = Math.max(peak, path); dd = Math.max(dd, peak - path); } });
      var early = G.filter(function (x) { return x.s.policy_decision === 'BET_EARLY' && x.g; }), waits = G.filter(function (x) { return x.s.decision_status === 'WAIT' && x.g; });
      var altG = G.filter(function (x) { return x.g && x.g.alt_results && x.g.alt_results.length; });
      return { label: label, n_reads: S.length, n_actionable: S.filter(function (s) { return s.actionable; }).length, n_policy_clears: S.filter(function (s) { return s.policy_clears; }).length,
        n_graded: graded.length, probability: { raw: raw, calibrated: cal, rates_shown: probs.length >= minN },
        clv: { n: clv.length, mean_pts: clv.length >= minN ? r(mean(clv), 3) : null, positive_rate: clv.length >= minN ? r(clv.filter(function (v) { return v > 0; }).length / clv.length, 3) : null },
        ev_buckets: buckets, monotone: monotoneCheck(buckets),
        shadow_policy: { n: shadowBets.length, units: r(path, 3), max_drawdown_units: r(dd, 3), note: 'flat 1u on every policy BET / BET EARLY at the recorded price — a shadow track, never a published wager' },
        timing: { bet_early: { n: early.length, later_deteriorated_rate: early.length >= minN ? r(early.filter(function (x) { return x.g.later_deteriorated; }).length / early.length, 3) : null },
          wait: { n: waits.length, target_reached_rate: waits.length >= minN ? r(waits.filter(function (x) { return x.g.target_reached; }).length / waits.length, 3) : null,
            mean_improvement_pts: waits.length >= minN ? r(mean(waits.map(function (x) { return x.g.wait_improvement_pts; })), 3) : null } },
        alternates: { n: altG.length, recommended_alt_units: altG.length >= minN ? r(mean(altG.map(function (x) { var a = x.g.alt_results.filter(function (y) { return y.verdict === 'BETTER_VALUE'; })[0]; return a ? a.units : null; })), 3) : null },
        quote_freshness_failures: S.filter(function (s) { return (s.blockers || []).indexOf('STALE_QUOTE') >= 0 || (s.blockers || []).indexOf('PRICE_UNAVAILABLE') >= 0; }).length };
    }
    var cur = opts.engine || VERSION, season = opts.season || null;
    var last = (snaps || []).slice().sort(function (a, b) { return ms(b.decision_ts) - ms(a.decision_ts); }).slice(0, opts.last_n || 100).map(function (s) { return s.snapshot_id; });
    var out = { schema: 'edgedesk_ev_validation_v1', min_n_for_rates: minN,
      groups: {
        current_ev_version: group(function (s) { return s.engine === cur && s.calibrator_version === (opts.calibrator_version || s.calibrator_version) && s.decision_policy_version === (opts.policy_version || s.decision_policy_version); }, 'CURRENT EV VERSION'),
        legacy: group(function (s) { return s.engine !== cur; }, 'LEGACY'),
        current_season: group(function (s) { return season == null || s.season === season; }, 'CURRENT SEASON'),
        last_n: group(function (s) { return last.indexOf(s.snapshot_id) >= 0; }, 'LAST ' + (opts.last_n || 100))
      },
      rule: 'Probability quality (Brier, log loss, slope) and CLV come first; realized ROI is shown with its interval and is not expected to equal stated EV at small n. Rates print at n ≥ ' + minN + '. Versions are never blended.' };
    out.research_triggers = researchTriggers(out.groups.current_ev_version, minN);
    return out;
  }
  function monotoneCheck(buckets) {
    var shown = buckets.filter(function (b) { return b.rates_shown && isNum(b.avg_clv_pts); });
    if (shown.length < 2) return { status: 'INSUFFICIENT_N', text: 'Fewer than two EV buckets have n ≥ the minimum.' };
    for (var i = 1; i < shown.length; i++) if (shown[i].avg_clv_pts < shown[i - 1].avg_clv_pts - 0.25) return { status: 'VIOLATED', text: 'A higher EV bucket captured less CLV than a lower one (' + shown[i].bucket + ' vs ' + shown[i - 1].bucket + ').' };
    return { status: 'OK', text: 'CLV does not fall as stated EV rises.' };
  }
  /* research candidates only on repeated evidence; production is never changed from here */
  function researchTriggers(G, minN) {
    var out = [];
    var b = G.ev_buckets.filter(function (x) { return x.rates_shown; });
    var hi = b.filter(function (x) { return /10%/.test(x.bucket) && x.bucket.indexOf('≥') === 0; })[0], mid = b.filter(function (x) { return x.bucket === '+2% to +5%'; })[0];
    if (hi && mid && isNum(hi.realized_roi) && isNum(mid.realized_roi) && hi.realized_roi < mid.realized_roi && isNum(hi.avg_clv_pts) && isNum(mid.avg_clv_pts) && hi.avg_clv_pts < mid.avg_clv_pts)
      out.push({ id: 'HIGH_EV_UNDERPERFORMS', text: 'High stated EV performs worse than moderate EV in both ROI and CLV.' });
    if (G.monotone.status === 'VIOLATED') out.push({ id: 'EV_CLV_NON_MONOTONE', text: G.monotone.text });
    if (G.probability.rates_shown && G.probability.calibrated.n >= minN && isNum(G.probability.calibrated.slope) && (G.probability.calibrated.slope < 0.6 || G.probability.calibrated.slope > 1.6))
      out.push({ id: 'CALIBRATOR_DRIFT', text: 'The live calibration slope is ' + G.probability.calibrated.slope + ' (1 is calibrated).' });
    if (G.timing.bet_early.n >= minN && isNum(G.timing.bet_early.later_deteriorated_rate) && G.timing.bet_early.later_deteriorated_rate < 0.5)
      out.push({ id: 'BET_EARLY_LOSES_CLV', text: 'BET EARLY reads saw the line improve more often than deteriorate.' });
    return out.map(function (x) { x.action = 'research candidate — no production change'; return x; });
  }

  /* ================================================================ ASK
     The assistant reads the EV object. It never computes a probability, an
     EV or a status, and it cites where every number came from; a missing
     fact is UNKNOWN. */
  var INTENTS = [
    { id: 'alt_juice', re: /(\balt\b|alternate|buy(ing)? (a |the )?(point|hook)|worth the juice|extra (point|juice)|juice worth)/i },
    { id: 'bet_or_wait', re: /\b(bet (it |this )?now|now or wait|bet now or|should i (bet|wait)|wait\b)/i },
    { id: 'worst_price', re: /\b(worst (price|number|line)|bettable|lowest (price|number)|how (bad|far)|what price kills|ev disappear)/i },
    { id: 'missed_number', re: /\b(miss(ed)? the number|price gone|too late|still there|edge (gone|decay))/i },
    { id: 'why_not_bet', re: /(why (is ?n'?t|not|isn't) (this|it) a bet|why not a bet|why no bet|positive (raw )?ev but|despite)/i },
    { id: 'why_positive', re: /\b(why (is )?(the )?ev (positive|high)|where does the ev come|why .*positive)/i }
  ];
  function provenance(o) {
    var s = o.selected || {};
    return { ev_read: o.schema + ' built ' + o.generated_at, model_version: o.model_version || 'UNKNOWN', calibrator_version: o.calibrator_version || 'UNKNOWN',
      calibration_status: o.calibration.status, policy_version: o.decision_policy_version, quote_id: s.quote_id || 'UNKNOWN', quote_source: s.source || 'UNKNOWN',
      quote_book: s.book || 'UNKNOWN', quote_ts: s.quote_ts || 'UNKNOWN', validation: o.calibration.oof ? 'tournament OOF n ' + (o.calibration.oof.n || '?') + ', log loss ' + (o.calibration.oof.log_loss || '?') : 'UNKNOWN' };
  }
  function ask(question, o) {
    var q = String(question || ''), id = null, i;
    for (i = 0; i < INTENTS.length; i++) if (INTENTS[i].re.test(q)) { id = INTENTS[i].id; break; }
    if (!id) return null;
    if (!o) return { intent: id, text: 'UNKNOWN: no EdgeDesk EV read for this game.', facts: [], provenance: null };
    var s = o.selected, facts = [], text;
    function f(claim, source) { facts.push({ claim: claim, source: source }); }
    switch (id) {
      case 'alt_juice': {
        var rows = o.main_vs_alt.rows.filter(function (x) { return x.vs_main; });
        if (!rows.length) { text = 'UNKNOWN for the alternates: no alternate price is on file for this game. Enter the alternate you see (line and odds) and EdgeDesk prices it through the same distribution.'; f(text, 'main_vs_alt'); break; }
        var b = rows[0].vs_main;
        text = b.from + ' vs ' + b.to + ': ' + b.explanation.join('; ') + '. Verdict: ' + b.verdict.replace(/_/g, ' ') + '.';
        f(text, 'juice panel (' + b.basis + ')');
        break;
      }
      case 'bet_or_wait':
        text = o.decision_status.replace(/_/g, ' ') + ' (timing ' + o.timing.replace(/_/g, ' ') + '). ' + o.decision_reason;
        f(o.decision_status, 'EV decision policy ' + o.decision_policy_version);
        break;
      case 'worst_price':
        text = o.bettable_to ? o.bettable_to.text + (o.bettable_to.ev_zero ? ' ' + o.bettable_to.ev_zero.text + '.' : '') : 'UNKNOWN: no threshold could be computed.';
        f(text, 'bettable-to engine');
        break;
      case 'missed_number':
        text = o.decision_status === 'PRICE_GONE' ? o.decision_reason : (o.edge_decay && o.edge_decay.text ? o.edge_decay.text : 'No earlier eligible read to compare with.');
        f(text, 'price gone / edge decay');
        break;
      case 'why_not_bet':
        text = o.actionable ? 'It is an actionable ' + o.decision_status.replace('_', ' ') + '.' : (o.blockers.length ? o.blockers.map(function (b) { return b.text; }).join(' · ') : o.decision_reason);
        f(text, 'blockers');
        break;
      case 'why_positive':
        if (!s) { text = 'UNKNOWN: no priced quote.'; break; }
        text = 'At ' + s.label + (s.book ? ' (' + s.book + ')' : '') + ': EdgeDesk’s ' + (isNum(s.p_cover_calibrated) ? 'calibrated' : 'raw') + ' cover probability is ' + pct(isNum(s.p_cover_calibrated) ? s.p_cover_calibrated : s.p_cover_raw, 1)
          + ' against a break-even of ' + pct(s.break_even_probability, 1) + ' at this exact price, so EV is ' + evText(isNum(s.calibrated_ev) ? s.calibrated_ev : s.raw_model_ev)
          + (isNum(s.calibrated_ev) ? '' : ' (raw, experimental)') + '. ' + (o.edge_kind && o.edge_kind.text ? o.edge_kind.text : '');
        f(text, 'EV option ' + (s.selection_id || ''));
        break;
    }
    return { intent: id, text: text, facts: facts, provenance: provenance(o) };
  }

  /* ============================================================ EXPORT */
  function exportRow(o) {
    var s = o.selected || {};
    return { game_id: o.game_id, kickoff: o.kickoff, home: o.home, away: o.away, model_version: o.model_version, calibrator_version: o.calibrator_version,
      calibration_status: o.calibration.status, policy_version: o.decision_policy_version, generated_at: o.generated_at, side: o.side_team, book: s.book || null,
      line: s.line != null ? s.line : null, odds: s.odds ? s.odds.american_display : null, quote_ts: s.quote_ts || null, p_cover_raw: s.p_cover_raw, p_cover_calibrated: s.p_cover_calibrated,
      p_push: s.p_push_raw, break_even: s.break_even_probability, probability_edge: s.probability_edge, raw_model_ev: s.raw_model_ev, calibrated_ev: s.calibrated_ev,
      conservative_ev: s.conservative_ev, prob_ev_positive: s.prob_ev_positive, decision_status: o.decision_status, policy_decision: o.policy_decision, timing: o.timing,
      research_status: o.research_status, blockers: o.blockers.map(function (b) { return b.code; }).join('|'), bettable_to_line: o.bettable_to && o.bettable_to.bettable_to ? o.bettable_to.bettable_to.line_at_current_price : null,
      target: o.target_price ? o.target_price.text : null, edge_kind: o.edge_kind ? o.edge_kind.kind : null, extreme: o.circuit_breaker.level };
  }
  function exportText(o) {
    var h = o.headline;
    return ['EDGEDESK EV · ' + o.away + ' @ ' + o.home,
      'Exact price: ' + (h.exact_price || '—') + ' · Fair line: ' + (h.fair_line || '—'),
      'Calibrated cover: ' + (h.calibrated_cover || '—') + ' · Break-even: ' + (h.break_even || '—') + ' · Probability edge: ' + (h.probability_edge || '—'),
      'Calibrated EV: ' + (h.calibrated_ev || '—') + ' · Robust EV: ' + (h.robust_ev || '—') + ' · Pr(EV>0): ' + (h.prob_ev_positive || '—') + ' · Raw EV: ' + (h.raw_ev || '—'),
      'Decision: ' + h.decision + ' · Timing: ' + h.timing + ' · Research status: ' + h.research_status,
      'Bettable to: ' + (h.bettable_to || '—'),
      'Calibration: ' + o.calibration.status + (o.calibration.method ? ' (' + o.calibration.method + ')' : '') + ' · Policy ' + o.decision_policy_version + ' (' + o.policy_maturity + ')',
      TOOLTIP].join('\n');
  }

  /* ========================================================= STAKING (DOWNSTREAM)
     Not enabled. Stake sizing is a separate problem from EV (pack K20):
     these functions exist for the staking study and its tests only. */
  function kellyFraction(pWin, pPush, decimal) {
    var b = decimal - 1, pu = isNum(pPush) ? pPush : 0, pl = 1 - pWin - pu;
    if (!(b > 0) || !isNum(pWin)) return 0;
    var num0 = pWin * b - pl, den = b * (pWin + pl);                 /* F22 */
    if (!(num0 > 0) || !(den > 0)) return 0;
    return num0 / den;
  }
  function robustKelly(coverSamples, pPush, decimal, lambda, cap, q) {
    var s = sortNum(coverSamples), pc = quantile(s, isNum(q) ? q : 0.10);
    if (!isNum(pc)) return 0;
    var f = kellyFraction(pc * (1 - pPush), pPush, decimal) * (isNum(lambda) ? lambda : 0.25);
    return Math.min(f, isNum(cap) ? cap : 0.01);
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, CAL_SCHEMA: CAL_SCHEMA, POLICY: POLICY, policyOf: policyOf, DECISION: DECISION, TOOLTIP: TOOLTIP, STATE: STATE, MARKETS: MARKETS,
    /* odds */
    americanToDecimal: americanToDecimal, decimalToAmerican: decimalToAmerican, decimalToAmericanRounded: decimalToAmericanRounded,
    fractionalToDecimal: fractionalToDecimal, hongKongToDecimal: hongKongToDecimal, malayToDecimal: malayToDecimal, indonesianToDecimal: indonesianToDecimal,
    impliedProbability: impliedProbability, normalizeOdds: normalizeOdds, parseOdds: parseOdds,
    /* settlement */
    marketSupport: marketSupport, payoffOf: payoffOf, expectedValue: expectedValue, twoWayStates: twoWayStates, twoWayEv: twoWayEv,
    asianQuarterStates: asianQuarterStates, asianQuarterEv: asianQuarterEv, exchangeBackStates: exchangeBackStates, exchangeLayStates: exchangeLayStates,
    breakEven: breakEven, fairDecimal: fairDecimal,
    /* market benchmark */
    devig: devig, DEVIG_METHODS: DEVIG_METHODS,
    /* probability + calibration */
    probabilityAt: probabilityAt, curvePmf: curvePmf, recentredHome: recentredHome, recentredSide: recentredSide, solveRecentre: solveRecentre, anchorOf: anchorOf, curveSane: curveSane,
    applyCalibrator: applyCalibrator, vennAbers: vennAbers, pav: pav, calibrationFor: calibrationFor, calibratedCover: calibratedCover,
    /* uncertainty, freshness */
    summarize: summarize, ttlFor: ttlFor, checkpointOf: checkpointOf, prng: prng, hash: hash, logisticSlope: logisticSlope, quantile: quantile,
    /* the read */
    contextOf: contextOf, evaluateOption: evaluateOption, juice: juice, priceTargets: priceTargets, edgeDecay: edgeDecay, circuitBreaker: circuitBreaker, recheck: recheck,
    evRead: evRead, whatIf: whatIf, manual: manual, compareLines: compareLines, keyCrossed: keyCrossed,
    snapshot: snapshot, validateSnapshot: validateSnapshot, shouldRecord: shouldRecord, P0_REQUIRED: P0_REQUIRED,
    grade: grade, validation: validation, researchTriggers: researchTriggers, EV_BUCKETS: EV_BUCKETS,
    ask: ask, INTENTS: INTENTS, provenance: provenance, exportRow: exportRow, exportText: exportText, auditText: auditText,
    kellyFraction: kellyFraction, robustKelly: robustKelly
  };
}));

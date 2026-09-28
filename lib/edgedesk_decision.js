/* ===========================================================================
   EDGEDESK BETTOR DECISION — the one bettor-facing answer per game.
   docs/bettor-decision/DESIGN.md

   EdgeDesk has several engines that each answer a narrower question:

     research status   how interesting is this matchup?   (lib/edgedesk_canon.js)
     quote EV          what is THIS exact quote worth?    (lib/edgedesk_quote_ev.js)
     EV read / policy  calibrated EV, circuit breaker     (lib/edgedesk_ev.js)
     governed engine   cfb_decision_policy_v1 (SHADOW)    (football/cfb_decision)

   A bettor should never have to reconcile them. This file reads their
   outputs and produces ONE deterministic, auditable object that answers:

     WHAT DO I DO?     BET / WAIT / PASS / NO_DECISION
     WHAT EXACTLY?     side, line, price, book, units, playable-to boundary
     WHY?              calibrated EV, fair line, reliability, market quality
     WHAT CANCELS IT?  the invalidation conditions, the transition history

   THE HIERARCHY (first failure wins; nothing later can override it)
     1. GAME STATE     cancelled / postponed / started / duplicate / mapping
     2. INTEGRITY      data fault, orientation, malformed or failed projection
     3. CALIBRATION    required for a price decision; missing → NO_DECISION
     4. MARKET QUALITY no market, stale, one-sided, market fault, unverified
     5. PRICE          every quote priced by EDQuoteEV at its exact line+price
     6. INFORMATION    unresolved QB / availability → WAIT (only if attractive)
     7. ANOMALY        a big edge gets MORE scrutiny, never a bigger stake
     8. CALIBRATED ADVANTAGE  calibrated EV below the action floor → PASS
     9. RELIABILITY / STABILITY / MARKET QUALITY floors → PASS
    10. RISK SIZING    0.25 / 0.50 / 0.75 / 1.00 U, rounded down through
                       every tier requirement; raw EV never enters it

   WHAT THIS FILE NEVER DOES
     - compute a probability or EV. Every number comes from EDQuoteEV.priceQuote
       on the model object the page/build already built (the champion's curve,
       and the calibrated side_prob from lib/edgedesk_ev.js). The playable
       boundary is a search over hypothetical quotes through that same function.
     - read a past result. Sizing has no input for wins, losses or streaks:
       no martingale, no loss-chasing, no "due" logic.
     - let raw EV, a model-market gap or a research status produce BET.
     - claim validation it does not have. Every threshold below is labelled
       CONSERVATIVE_DEFAULT_UNVALIDATED; the 1.00U tier stays shadow-only until
       its own live validation is recorded in the config.

   Browser: window.EDDecision (load lib/research_core.js and
   lib/edgedesk_quote_ev.js first). Node: require('./edgedesk_decision.js').
   ES5, no other dependencies.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDDecision = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_bettor_decision_v1';
  var CONFIG_VERSION = 'bettor_decision_config_v1';

  var Qm = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) { try { Qm = require('./edgedesk_quote_ev.js'); } catch (e) { Qm = null; } }
  function Q() {
    var q = Qm || (root && root.EDQuoteEV);
    if (!q || typeof q.priceQuote !== 'function') throw new Error('EDDecision needs lib/edgedesk_quote_ev.js (EDQuoteEV) loaded first');
    return q;
  }

  /* ------------------------------------------------------------- helpers */
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 6 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  function merge(a, b) {
    var o = copy(a) || {}, k;
    if (!b) return o;
    for (k in b) if (has(b, k)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) o[k] = merge(o[k], b[k]);
      else o[k] = copy(b[k]);
    }
    return o;
  }
  function hash(parts) {
    var s = typeof parts === 'string' ? parts : JSON.stringify(parts), h = 0x811c9dc5, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function pctText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2).replace(/0$/, '') + 'U' : '—'; }
  function otherSide(s) { return s === 'home' ? 'away' : 'home'; }
  function upper(s) { return s == null ? null : String(s).toUpperCase(); }

  /* ================================================================ CONFIG
     Every number is configurable. None is empirically validated yet: each
     carries that label, and the report says so. The governed CFB policy
     (cfb_decision_policy_v1) found no BET region on its holdout; these rules
     do not claim otherwise — they gate on the calibrated EV, which is itself
     what the out-of-sample calibration supports, and they size conservatively. */
  var UNVALIDATED = 'CONSERVATIVE_DEFAULT_UNVALIDATED';
  var DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    validation_state: UNVALIDATED,
    /* which markets this layer may decide, and who holds BET authority.
       bet_authority:
         BETTOR_RULES     BET when every rule below clears (labelled unvalidated)
         GOVERNED_POLICY  BET only when the governed policy has bet_enabled
         NONE             never BET for this market (NO_DECISION: unsupported) */
    markets: {
      'CFB:spread': { supported: true, bet_authority: 'BETTOR_RULES', calibration_required: true },
      'NFL:spread': { supported: true, bet_authority: 'BETTOR_RULES', calibration_required: true },
      'CFB:total': { supported: false, bet_authority: 'NONE', calibration_required: true },
      'NFL:total': { supported: false, bet_authority: 'NONE', calibration_required: true },
      'CFB:moneyline': { supported: false, bet_authority: 'NONE', calibration_required: true },
      'NFL:moneyline': { supported: false, bet_authority: 'NONE', calibration_required: true }
    },
    action: {
      min_calibrated_ev: 0.015,        /* the BET floor, on the calibrated EV at the exact quote */
      min_reliability: 60,             /* EdgeDesk's own reliability floor (lib/edgedesk_canon.js THRESHOLDS) */
      min_confidence: 35,              /* football confidence floor (same) */
      min_market_quality: 'ACCEPTABLE',
      reject_low_stability: true,
      require_two_sided: true
    },
    /* WAIT needs a potentially attractive opportunity. When the market itself
       cannot be trusted the calibrated EV cannot be either (the calibrator is
       anchored at the market line), so attractiveness is read from the raw
       signal — only to decide between WAIT and NO_DECISION, never toward BET. */
    wait: { min_raw_ev: 0.03, min_gap_pts: 2 },
    anomaly: {
      gap_pts: 7,                      /* research major_gap */
      raw_ev: 0.20,
      move_pts: 3,
      min_books: 2,
      cleared_unit_cap: 0.50,          /* a cleared anomaly can never size above this */
      /* a SEVERE extreme (beyond the out-of-sample 99th percentile) is never
         sized above the smallest tier even when every check clears */
      severe_unit_cap: 0.25,
      /* "multiple books where required": corroboration is required when the
         edge is large even after calibration, the raw edge is extreme, or the
         gap is major. A modest edge at one book proceeds, capped by market quality. */
      multi_book_required: { calibrated_ev: 0.05, raw_ev: 0.20, gap_pts: 7 }
    },
    market_quality: { verified_min_books: 2, strong_min_books: 2, max_dispersion: 1.5 },
    sizing: {
      max_units: 1.00,                 /* never above 1.00U in the standard interface */
      /* until a tier has its own live validation, nothing above this is recommended */
      max_active_units_unvalidated: 0.75,
      validated_tiers: [],             /* e.g. [0.25, 0.5] once the record supports them */
      material_warnings: ['ANOMALY_CLEARED', 'LARGE_RATING_DIVERGENCE', 'FCS_GAME', 'QB_CONTESTED', 'AVAILABILITY_UNCERTAIN', 'ALT_LINE_TAIL', 'STABILITY_UNMEASURED'],
      weights: { calibrated_ev: 0.25, reliability: 0.15, market_quality: 0.12, stability: 0.10, support: 0.08, uncertainty: 0.08, integrity: 0.08, quote_quality: 0.06, calibration: 0.05, validation: 0.03 },
      tiers: [
        { units: 0.25, strength: 'QUALIFIED', min_calibrated_ev: 0.015, min_reliability: 60, min_market_quality: 'ACCEPTABLE', min_stability: 'UNMEASURED', min_support: 0, min_score: 0, allow_material_warnings: true },
        { units: 0.50, strength: 'STRONG', min_calibrated_ev: 0.03, min_reliability: 70, min_market_quality: 'STRONG', min_stability: 'MEDIUM', min_support: 1, min_score: 55, allow_material_warnings: false },
        { units: 0.75, strength: 'VERY_STRONG', min_calibrated_ev: 0.05, min_reliability: 80, min_market_quality: 'VERIFIED', min_stability: 'HIGH', min_support: 2, min_score: 70, allow_material_warnings: false },
        { units: 1.00, strength: 'VERY_STRONG', min_calibrated_ev: 0.07, min_reliability: 85, min_market_quality: 'VERIFIED', min_stability: 'HIGH', min_support: 2, min_score: 82, allow_material_warnings: false,
          require_qb_certain: true, require_availability_certain: true, require_no_anomaly: true, require_tier_validation: true }
      ]
    },
    playable: { max_points: 3, odds_floor: -250, odds_ceiling: 1000 },
    trigger: { max_points: 6 }
  };

  var MQ_ORDER = { INVALID: 0, THIN: 1, ACCEPTABLE: 2, STRONG: 3, VERIFIED: 4 };
  var STAB_ORDER = { LOW: 0, UNMEASURED: 1, MEDIUM: 2, HIGH: 3 };

  function config(over) { return deepFreeze(merge(DEFAULT_CONFIG, over || null)); }

  /* ================================================================= WORDS */
  var DECISIONS = {
    BET: { key: 'BET', label: 'BET', tone: 'bet', headline: 'Current price qualifies',
      means: 'The current price clears every required EdgeDesk gate: integrity, market quality, price, calibrated edge, reliability and sizing.' },
    WAIT: { key: 'WAIT', label: 'WAIT', tone: 'wait', headline: 'DO NOT BET YET',
      means: 'A potential opportunity exists, but information required for a valid decision is unresolved. WAIT always means do not bet yet.' },
    PASS: { key: 'PASS', label: 'PASS', tone: 'pass', headline: 'Current price does not justify a wager',
      means: 'EdgeDesk can evaluate this wager, but the current price is not good enough.' },
    NO_DECISION: { key: 'NO_DECISION', label: 'NO DECISION', tone: 'none', headline: 'Not enough verified information to evaluate this wager',
      means: 'Required market or model information is unavailable, so EdgeDesk cannot responsibly evaluate the wager.' }
  };
  var DECISION_KEYS = ['BET', 'WAIT', 'PASS', 'NO_DECISION'];
  var STRENGTH = {
    QUALIFIED: { key: 'QUALIFIED', label: 'Qualified', rank: 1 },
    STRONG: { key: 'STRONG', label: 'Strong', rank: 2 },
    VERY_STRONG: { key: 'VERY_STRONG', label: 'Very strong', rank: 3 }
  };
  /* reason code → decision class and the sentence a bettor reads */
  var REASONS = {
    QUALIFIES: ['BET', 'Current price remains positive after calibration and clears EdgeDesk’s integrity, market, reliability and pricing requirements.'],
    GAME_CANCELLED: ['NO_DECISION', 'The game was cancelled.'],
    GAME_POSTPONED: ['NO_DECISION', 'The game was postponed.'],
    GAME_SUSPENDED: ['NO_DECISION', 'The game is suspended.'],
    GAME_STARTED: ['NO_DECISION', 'The game has started: pregame decisions are closed.'],
    INVALID_GAME: ['NO_DECISION', 'The game could not be identified.'],
    DUPLICATE_GAME: ['NO_DECISION', 'This game maps to more than one event: the mapping must be resolved first.'],
    ORIENTATION_FAULT: ['NO_DECISION', 'The home/away orientation or spread sign failed its check.'],
    UNSUPPORTED_MARKET: ['NO_DECISION', 'This market is not supported by the decision layer.'],
    DATA_FAULT: ['NO_DECISION', 'An integrity check found a data fault: EdgeDesk’s number is unsafe until it is explained.'],
    MODEL_UNAVAILABLE: ['NO_DECISION', 'No valid EdgeDesk projection exists for this game.'],
    MALFORMED_PROJECTION: ['NO_DECISION', 'The projection failed its distribution checks.'],
    SELF_CHECK_FAILED: ['NO_DECISION', 'The model failed its own self-check.'],
    INSUFFICIENT_MODEL_DATA: ['NO_DECISION', 'Not enough model data to evaluate this wager responsibly.'],
    RELIABILITY_UNMEASURED: ['NO_DECISION', 'Reliability could not be measured for this game.'],
    CALIBRATION_UNAVAILABLE: ['NO_DECISION', 'No validated probability calibration exists for this market, so the price cannot be judged.'],
    NO_MARKET: ['NO_DECISION', 'No sportsbook market is on file.'],
    NO_VALID_QUOTE: ['NO_DECISION', 'No valid priced quote is available.'],
    STALE_QUOTE: ['NO_DECISION', 'The only quotes on file are older than EdgeDesk’s freshness limit.'],
    NO_TWO_SIDED_MARKET: ['NO_DECISION', 'No valid two-sided market: the other side is not priced at this number.'],
    MARKET_FAULT: ['NO_DECISION', 'The market failed its integrity checks.'],
    UNVERIFIED_LARGE_GAP: ['NO_DECISION', 'A large gap has not been verified and shows no priced opportunity.'],
    MARKET_VERIFICATION_PENDING: ['WAIT', 'The apparent edge is unusually large and required market verification has not cleared. Large discrepancies receive additional scrutiny before becoming actionable.'],
    MARKET_FAULT_UNDER_REVIEW: ['WAIT', 'The market failed an integrity check that may resolve (a stale or conflicting book). No bet until it is re-verified.'],
    QB_UNRESOLVED: ['WAIT', 'The starting quarterback is unresolved. The price qualifies only if the projection survives confirmation.'],
    AVAILABILITY_PENDING: ['WAIT', 'A material availability update is pending.'],
    ANOMALY_REVIEW: ['WAIT', 'The edge triggered EdgeDesk’s anomaly review and not every check has cleared.'],
    LINE_SUSPENDED: ['WAIT', 'The line is temporarily off the board.'],
    QUOTE_REFRESH_PENDING: ['WAIT', 'The price EdgeDesk evaluated is now older than the freshness limit. Re-check before acting.'],
    CALIBRATED_EV_NEGATIVE: ['PASS', 'The apparent model edge disappears after calibration.'],
    NO_MODEL_EDGE: ['PASS', 'EdgeDesk’s model does not favour either side at the current prices.'],
    CALIBRATED_EV_BELOW_THRESHOLD: ['PASS', 'The calibrated edge is positive but below EdgeDesk’s action threshold.'],
    PRICE_MOVED: ['PASS', 'The price moved past EdgeDesk’s playable threshold.'],
    PROJECTION_CHANGED: ['PASS', 'New information changed EdgeDesk’s projection, and the current price no longer clears the action threshold.'],
    LOW_RELIABILITY: ['PASS', 'Reliability is below EdgeDesk’s betting threshold.'],
    UNSTABLE_PROJECTION: ['PASS', 'The projection is too unstable to act on.'],
    THIN_MARKET: ['PASS', 'Market quality is below the betting requirement.'],
    SIZING_ZERO: ['PASS', 'No stake could be sized responsibly at this price.'],
    ALT_TAIL_ONLY: ['PASS', 'Only an alternate line outside EdgeDesk’s validated range qualifies.'],
    BET_AUTHORITY_DISABLED: ['PASS', 'The price clears EdgeDesk’s rules, but betting authority for this market is held by a governed policy that has not enabled betting.']
  };
  function reasonText(code) { return REASONS[code] ? REASONS[code][1] : code; }

  /* the definitions the page shows, verbatim, one home */
  var TOOLTIP = {
    calibrated_ev: 'Expected value after EdgeDesk adjusts model probabilities using observed out-of-sample performance. More conservative than raw model EV.',
    raw_ev: 'Expected value based directly on the current model probability and sportsbook price before calibration.',
    reliability: 'A 0-100 measure of data quality, freshness, source agreement, and projection stability. Not a win probability.',
    unit: 'A standardized stake size. EdgeDesk defaults 1 unit to 1% of bankroll.',
    playable_to: 'The worst line and price at which the wager still clears EdgeDesk’s action threshold, assuming the rest of the market stays where it is. EdgeDesk re-evaluates whenever the market moves.',
    research_status: 'Describes whether the matchup deserves investigation.',
    bet_decision: 'Describes whether the current market price qualifies for action.',
    edge_strength: 'A restrained label built from calibrated EV, reliability, market quality, stability, independent support, integrity, availability and QB certainty, and validation state — never from the model-market gap alone.',
    model_fair: 'EdgeDesk’s own fair line for this game. The sportsbook market never enters it.',
    best_available: 'The best main-line price for this side across the books on file.',
    consensus: 'The number most books are dealing.',
    bet_price: 'The exact quote the decision was reached on: this line, this price, this book.',
    cover_probability: 'EdgeDesk’s model probability that this side covers this exact line. A model estimate, not a guarantee.',
    market_quality: 'VERIFIED: two-sided and corroborated by several fresh books. STRONG: two-sided, several books. ACCEPTABLE: two-sided at one fresh book. THIN: one-sided or single stale-prone quote.',
    validation: 'These decision thresholds and stake tiers are conservative defaults. They have not yet been validated on live results.'
  };

  /* ====================================================== QUOTE HELPERS
     The priced quote object is EDQuoteEV's. These read it; they compute nothing. */
  var INTEGRITY_FLAGS = ['BREAK_EVEN_MISMATCH', 'EV_INCONSISTENT', 'EV_EDGE_SIGN', 'BOOK_MISMATCH', 'UNEXPECTED_PUSH', 'INTEGER_PUSH_MISSING', 'ORIENTATION_MISMATCH', 'EV_UNDER_NEG_50'];
  var MAGNITUDE_FLAGS = ['EV_OVER_25', 'ALT_EV_OVER_35', 'COVER_OVER_75', 'LARGE_EV_LOW_RELIABILITY', 'LARGE_EV_QB_UNRESOLVED', 'LARGE_EV_STALE_MARKET', 'LARGE_EV_MARKET_FAULT'];
  /* quotes or a distribution that disagree with themselves (a book simply
     beating another book — BETTER_LINE_AND_PRICE_ELSEWHERE — is line shopping,
     not an inconsistency, and triggers nothing) */
  var INCONSISTENT_FLAGS = ['CONTRADICTORY_PROBABILITY', 'ARBITRAGE_CONDITION', 'BOTH_SIDES_POSITIVE', 'COVER_NON_MONOTONE', 'ALT_DISCONTINUITY'];
  function flagCodes(o) { return ((o && o.flags) || []).map(function (f) { return f.code; }); }
  function hasFlag(o, list) { var c = flagCodes(o); return c.some(function (x) { return list.indexOf(x) >= 0; }); }
  function calEv(o) { return o && o.adjusted && o.adjusted.available && isNum(o.adjusted.expected_value) ? o.adjusted.expected_value : null; }
  function calCover(o) { return o && o.adjusted && o.adjusted.available ? o.adjusted.model_cover_probability : null; }
  function calWin(o) { return o && o.adjusted && o.adjusted.available ? o.adjusted.model_win_probability : null; }
  function calPush(o) { return o && o.adjusted && o.adjusted.available ? (o.adjusted.model_push_probability || 0) : null; }
  function calLoss(o) { return o && o.adjusted && o.adjusted.available ? o.adjusted.model_loss_probability : null; }
  /* the standard deviation of the per-unit return, on the calibrated
     probabilities: the risk a plus-money alternate carries that EV alone hides */
  function returnSd(o) {
    var w = calWin(o), p = calPush(o), l = calLoss(o), d = o ? o.decimal_odds : null;
    if (!isNum(w) || !isNum(l) || !isNum(d)) return null;
    var mu = w * (d - 1) - l, m2 = w * (d - 1) * (d - 1) + l;
    var v = m2 - mu * mu;
    return v > 0 ? Math.sqrt(v) : null;
  }
  /* how far apart the books' fresh main lines sit on one side (points) */
  function quoteDispersion(priced) {
    var out = 0;
    ['home', 'away'].forEach(function (s) {
      var ls = priced.filter(function (o) { return o.side === s && o.is_main_line && o.ev_available && isNum(o.line); }).map(function (o) { return o.line; });
      if (ls.length > 1) out = Math.max(out, Math.max.apply(null, ls) - Math.min.apply(null, ls));
    });
    return out;
  }
  /* a book that prices both sides must mirror them (+6.5 / −6.5); a book whose
     two sides do not mirror has the side mapping or the sign wrong. (Books
     disagreeing with EACH OTHER is dispersion, reviewed as an anomaly.) */
  function mirrorFault(priced) {
    var by = {};
    priced.forEach(function (o) { if (!o.is_main_line || !isNum(o.line) || !o.sportsbook) return; var k = String(o.sportsbook).toLowerCase(); (by[k] = by[k] || { home: [], away: [] })[o.side].push(o.line); });
    return Object.keys(by).some(function (k) {
      var b = by[k]; if (!b.home.length || !b.away.length) return false;
      return !b.home.some(function (h) { return b.away.some(function (a) { return Math.abs(h + a) < EPS; }); });
    });
  }
  function riskAdjusted(o) { var e = calEv(o), s = returnSd(o); return isNum(e) && isNum(s) && s > 0 ? e / s : null; }
  function tailOk(o) { return !o.tail || o.tail.status !== 'NOT_VALIDATED'; }
  function quoteSummary(o) {
    if (!o) return null;
    return { side: o.side, team: o.team, market_type: o.market_type, is_main_line: !!o.is_main_line, line: o.line, odds: o.american_odds, decimal: o.decimal_odds,
      book: o.sportsbook, captured_at: o.captured_at, quote_age_minutes: o.quote_age_minutes, label: (o.team || o.side) + ' ' + lineText(o.line) + ' (' + priceText(o.american_odds) + ')',
      cover_probability: o.model_cover_probability, push_probability: o.model_push_probability, break_even_probability: o.break_even_probability,
      raw_ev: o.expected_value, calibrated_ev: calEv(o), calibrated_cover: calCover(o), fair_odds: o.model_fair_odds,
      risk_adjusted: r(riskAdjusted(o), 5), tail: o.tail ? o.tail.status : null, flags: flagCodes(o) };
  }
  /* two-sided: the mirrored number on the other side is priced and fresh.
     same_book records whether one book priced both (the governed engine's rule). */
  function twoSidedOf(o, priced) {
    var mirror = priced.filter(function (x) { return x.side === otherSide(o.side) && isNum(x.line) && Math.abs(x.line + o.line) < EPS && isNum(x.decimal_odds) && x.quote_status !== 'STALE' && x.ev_unavailable_code !== 'STALE'; });
    return { two_sided: mirror.length > 0, same_book: mirror.some(function (x) { return String(x.sportsbook || '').toLowerCase() === String(o.sportsbook || '').toLowerCase(); }) };
  }

  /* ======================================================= INPUT READERS */
  function marketKey(input) { return upper(input.sport || (input.model && input.model.sport) || 'CFB') + ':' + (input.market_type || 'spread'); }
  function gameState(input) { var g = input.game || {}; return upper(g.state || g.status || null); }
  function qevCtx(input) {
    var c = copy(input.qev_ctx || {}) || {};
    c.now = input.now != null ? input.now : c.now;
    if (!c.game) c.game = input.game ? { game_id: input.game.game_id, home: input.game.home, away: input.game.away, kickoff: input.game.kickoff } : null;
    return c;
  }
  /* the priced game: the caller's EDQuoteEV.evaluateGame result when it has
     one (the page and build already computed it), else computed here, once */
  function evaluation(input) {
    if (input.evaluation && input.evaluation.sides) return input.evaluation;
    if (!input.model || !input.quotes) return null;
    return Q().evaluateGame(input.model, input.quotes, qevCtx(input));
  }
  function allPriced(G) {
    var out = [];
    ['home', 'away'].forEach(function (s) { ((G && G.sides && G.sides[s] && G.sides[s].quotes) || []).forEach(function (o) { out.push(o); }); });
    return out;
  }
  function fairLineForSide(input, side) {
    var m = input.model ? num(input.model.fair_home_margin) : null;
    if (m == null) return null;
    return side === 'home' ? -m : m;
  }
  function teamOf(input, side) { var g = input.game || {}; return side === 'home' ? g.home : (side === 'away' ? g.away : null); }
  /* independent submodels agreeing with THIS side (per-side counts when the adapter has them) */
  function supportFor(input, side) {
    var sup = input.support || {};
    if (sup.by_side && side && isNum(num(sup.by_side[side]))) return num(sup.by_side[side]);
    return num(sup.independent_count);
  }

  /* market quality, from the market facts the adapter gathered and the
     two-sidedness of the quote under evaluation */
  function marketQuality(input, sel, priced, cfg) {
    var M = input.market || {}, C = cfg.market_quality;
    if (!sel) return 'INVALID';
    if (M.fault || M.stale) return 'INVALID';
    var ts = twoSidedOf(sel, priced);
    if (!ts.two_sided) return 'THIN';
    var books = num(M.n_books_fresh);
    if (books == null) books = num(sel.n_books_at_line) || 1;
    var disp = num(M.dispersion);
    var dispOk = disp == null || disp <= C.max_dispersion + EPS;
    var verified = M.verified !== false && (input.research || {}).verification !== 'FAILED' && (input.research || {}).verification !== 'INCOMPLETE';
    if (books >= C.verified_min_books && ts.same_book && dispOk && verified) return 'VERIFIED';
    if (books >= C.strong_min_books && dispOk) return 'STRONG';
    return 'ACCEPTABLE';
  }
  function stabilityOf(input) {
    var P = input.projection || {};
    var s = upper(P.stability);
    if (s === 'VERY_STABLE' || s === 'STABLE' || s === 'HIGH') return 'HIGH';
    if (s === 'MODERATE' || s === 'MEDIUM') return 'MEDIUM';
    if (s === 'UNSTABLE' || s === 'VERY_UNSTABLE' || s === 'LOW') return 'LOW';
    var sd = num(P.model_sd);
    if (sd != null) return sd <= 1.5 ? 'HIGH' : (sd <= 3 ? 'MEDIUM' : 'LOW');
    return 'UNMEASURED';
  }

  /* =================================================== ANOMALY REVIEW
     Triggers are about size and strangeness; checks are about whether the
     edge is real. A cleared anomaly may proceed, capped; it is never boosted. */
  function anomalyReview(input, sel, priced, G, cfg) {
    var A = cfg.anomaly, R = input.research || {}, M = input.market || {}, X = input.anomaly || {}, I = input.integrity || {}, g = input.game || {};
    var triggers = [], checks = [];
    function trig(code, text) { triggers.push({ code: code, text: text }); }
    function check(code, status, text) { checks.push({ code: code, status: status, text: text }); }
    var gap = num(R.gap_pts);
    if (gap != null && gap >= A.gap_pts - EPS) trig('LARGE_GAP', 'model–market gap ' + gap.toFixed(1) + ' pts (review at ' + A.gap_pts + ')');
    if (sel && isNum(sel.expected_value) && sel.expected_value >= A.raw_ev) trig('EXTREME_RAW_EV', 'raw EV ' + pctText(sel.expected_value) + ' (review at ' + pctText(A.raw_ev, 0) + ')');
    if (sel && hasFlag(sel, MAGNITUDE_FLAGS)) trig('SANITY_FLAG', 'sanity guard: ' + flagCodes(sel).filter(function (c) { return MAGNITUDE_FLAGS.indexOf(c) >= 0; }).join(', ').toLowerCase());
    if (X.favorite_flip) trig('FAVORITE_FLIP', 'EdgeDesk and the market favour opposite sides');
    if (upper(X.rating_divergence_band) === 'LARGE') trig('RATING_DIVERGENCE', 'large disagreement between the current rating and the production pricing state');
    var books = num(M.n_books_fresh);
    if (books != null && books < A.min_books) trig('LIMITED_BOOKS', books + ' fresh book' + (books === 1 ? '' : 's'));
    if (X.fcs || (g && g.fcs)) trig('FCS_INVOLVED', 'an FCS team is involved');
    if (X.small_market) trig('SMALL_MARKET_TEAM', 'a smaller-market team with thin coverage');
    var mv = num(M.movement_pts);
    if (mv != null && Math.abs(mv) >= A.move_pts - EPS) trig('ABNORMAL_MOVEMENT', 'line moved ' + Math.abs(mv).toFixed(1) + ' pts since open');
    var inc = (G && G.flags || []).concat(sel ? sel.flags || [] : []).filter(function (f) { return INCONSISTENT_FLAGS.indexOf(f.code) >= 0 || f.code === 'BOOK_MISMATCH'; });
    if (inc.length) trig('INCONSISTENT_QUOTES', inc.map(function (f) { return f.code.replace(/_/g, ' ').toLowerCase(); }).join(', '));
    var disp = Math.max(num(M.dispersion) || 0, quoteDispersion(priced));
    var dispBad = disp > cfg.market_quality.max_dispersion + EPS;
    if (dispBad) trig('BOOK_DISPERSION', 'the books disagree by ' + disp.toFixed(1) + ' pts (limit ' + cfg.market_quality.max_dispersion + ')');
    var CB = X.circuit_breaker || null;
    if (CB && CB.triggered) trig('CIRCUIT_BREAKER', 'EV circuit breaker: ' + (CB.level || 'REVIEW'));
    var out = { triggered: triggers.length > 0, severe: !!(CB && CB.level === 'SEVERE'), triggers: triggers, checks: checks, cleared: null };
    if (!out.triggered) return out;

    /* the checks: PASS / FAIL / UNKNOWN. UNKNOWN never clears. */
    check('CORRECT_TEAMS', g.mapping_ok === false ? 'FAIL' : (g.mapping_ok === true ? 'PASS' : 'UNKNOWN'), 'teams resolved to the right event');
    check('ORIENTATION', g.orientation_ok === false || (sel && hasFlag(sel, ['ORIENTATION_MISMATCH'])) ? 'FAIL' : (g.orientation_ok === true ? 'PASS' : 'UNKNOWN'), 'home/away orientation');
    var fair = input.model ? num(input.model.fair_home_margin) : null, mh = num(M.consensus_home_line);
    var signFlip = fair != null && mh != null && Math.abs(fair + mh) > 21 && Math.abs(fair - mh) <= 7;
    check('SPREAD_SIGN', fair == null || mh == null ? 'UNKNOWN' : (signFlip ? 'FAIL' : 'PASS'), 'a gap that vanishes when the market sign is flipped is a sign fault');
    check('FRESH_MARKET', sel && sel.quote_status === 'FRESH' ? 'PASS' : 'FAIL', 'the evaluated quote is fresh');
    var ts = sel ? twoSidedOf(sel, priced) : { two_sided: false };
    check('TWO_SIDED', ts.two_sided ? 'PASS' : 'FAIL', 'both sides priced at this number');
    var MR = A.multi_book_required || {}, ceSel = sel ? calEv(sel) : null;
    var needBooks = (isNum(ceSel) && ceSel >= MR.calibrated_ev - EPS) || (sel && isNum(sel.expected_value) && sel.expected_value >= MR.raw_ev - EPS) || (gap != null && gap >= MR.gap_pts - EPS);
    check('MULTIPLE_BOOKS', !needBooks ? 'PASS' : (books == null ? 'UNKNOWN' : (books >= A.min_books ? 'PASS' : 'FAIL')), needBooks ? 'at least ' + A.min_books + ' fresh books at this edge size' : 'one book suffices at this edge size (market quality caps the stake)');
    var qb = input.qb || {};
    check('QB_STATE', qb.unresolved_critical ? 'FAIL' : (qb.known === false ? 'UNKNOWN' : 'PASS'), 'starting quarterbacks resolved');
    var av = input.availability || {};
    check('AVAILABILITY', av.major_uncertainty || av.pending ? 'FAIL' : (av.known === false ? 'UNKNOWN' : 'PASS'), 'no material availability uncertainty');
    check('MODEL_VERSION', input.model && input.model.model_version ? 'PASS' : 'FAIL', 'the model version is recorded');
    var ko = ms(g.kickoff), now = ms(input.now);
    check('SCHEDULE', ko == null ? 'UNKNOWN' : (now != null && ko > now && ko - now < 10 * 864e5 ? 'PASS' : 'FAIL'), 'a valid upcoming kickoff');
    check('CURRENT_SEASON', X.current_season === false ? 'FAIL' : (X.current_season === true ? 'PASS' : 'UNKNOWN'), 'current-season team state');
    var gatesFail = (I.gates || []).filter(function (x) { return upper(x.status) === 'FAIL'; });
    check('ADJUSTMENT_BOUNDS', gatesFail.length ? 'FAIL' : ((I.gates || []).length ? 'PASS' : 'UNKNOWN'), gatesFail.length ? gatesFail.map(function (x) { return x.id; }).join(', ') : 'integrity gates within bounds');
    var supN = sel ? supportFor(input, sel.side) : null;
    check('INDEPENDENT_SUBMODELS', supN == null ? 'UNKNOWN' : (supN >= 1 ? 'PASS' : 'FAIL'), 'at least one independent submodel agrees on the side');
    check('CONSISTENT_QUOTES', inc.length ? 'FAIL' : 'PASS', 'no quote contradicts another (arbitrage, both sides positive, non-monotone cover)');
    check('BOOK_AGREEMENT', dispBad ? 'FAIL' : 'PASS', 'the books agree within ' + cfg.market_quality.max_dispersion + ' pts');
    var ce = sel ? calEv(sel) : null;
    check('CALIBRATION_SURVIVAL', ce == null ? 'UNKNOWN' : (ce >= cfg.action.min_calibrated_ev - EPS ? 'PASS' : 'FAIL'), 'the edge survives calibration');
    if (CB && CB.triggered) check('CIRCUIT_BREAKER_VERIFIED', CB.verified === true ? 'PASS' : 'FAIL', 'the EV engine’s extreme-edge checks');
    out.cleared = checks.every(function (c) { return c.status === 'PASS'; });
    return out;
  }

  /* ====================================================== CANDIDATES
     Every quote with a calibrated EV, inside the validated tail, with no
     integrity-class sanity flag. The recommendation is the best RISK-ADJUSTED
     qualifying quote (calibrated EV per unit of return SD) — not the biggest
     payout and not the biggest EV. SAFER and BETTER VALUE are reported apart. */
  function eligible(o) { return o.ev_available && isNum(calEv(o)) && tailOk(o) && !hasFlag(o, INTEGRITY_FLAGS); }
  function better(a, b) {            /* a strictly preferred to b as the recommendation? */
    if (!b) return true;
    var ra = riskAdjusted(a), rb = riskAdjusted(b);
    if (isNum(ra) && isNum(rb) && Math.abs(ra - rb) > 1e-6) return ra > rb;
    if (a.is_main_line !== b.is_main_line) return !!a.is_main_line;
    if (Math.abs(calEv(a) - calEv(b)) > EPS) return calEv(a) > calEv(b);
    return a.line > b.line;
  }
  function selectQuote(priced, cfg, sideFilter) {
    var thr = cfg.action.min_calibrated_ev;
    var pool = priced.filter(function (o) { return eligible(o) && (!sideFilter || o.side === sideFilter); });
    var qualifying = pool.filter(function (o) { return calEv(o) >= thr - EPS; });
    var rec = null;
    qualifying.forEach(function (o) { if (better(o, rec)) rec = o; });
    /* with nothing qualifying, the reference quote for a PASS sits on the side
       the model leans (the higher raw EV at the main line), at that side's best
       calibrated main-line quote: what a bettor would be tempted by, and why not */
    var lean = null;
    pool.forEach(function (o) { if (o.is_main_line && isNum(o.expected_value) && (!lean || o.expected_value > lean.expected_value + EPS)) lean = o; });
    var leanSide = lean ? lean.side : null;
    var ref = null;
    pool.forEach(function (o) {
      if (leanSide && o.side !== leanSide) return;
      if (!ref) { ref = o; return; }
      if (o.is_main_line !== ref.is_main_line) { if (o.is_main_line) ref = o; return; }
      if (calEv(o) > calEv(ref) + EPS || (Math.abs(calEv(o) - calEv(ref)) <= EPS && o.line > ref.line)) ref = o;
    });
    var side = rec ? rec.side : null;
    var sameSide = qualifying.filter(function (o) { return o.side === side; });
    var safer = null, value = null, aggressive = null;
    sameSide.forEach(function (o) {
      if (!safer || calCover(o) > calCover(safer) + EPS) safer = o;
      if (!value || calEv(o) > calEv(value) + EPS) value = o;
      if (!aggressive || o.decimal_odds > aggressive.decimal_odds + EPS) aggressive = o;
    });
    var main = null;
    if (side) priced.forEach(function (o) { if (o.side === side && o.is_main_line && o.ev_available && (!main || o.line > main.line + EPS || (Math.abs(o.line - main.line) < EPS && o.decimal_odds > main.decimal_odds))) main = o; });
    return { recommended: rec, reference: ref, qualifying: qualifying, n_eligible: pool.length,
      alternatives: rec ? { main: main, safer: safer && safer !== rec ? safer : null, better_value: value && value !== rec ? value : null, aggressive: aggressive && aggressive !== rec && aggressive !== value ? aggressive : null } : null,
      tail_only: !rec && priced.some(function (o) { return o.ev_available && isNum(calEv(o)) && calEv(o) >= thr - EPS && !tailOk(o); }) };
  }

  /* ======================================================== PRICE SEARCH
     A hypothetical quote priced by EDQuoteEV on the same model. The search
     never invents a probability: it moves only the line and the price. */
  function hypoQuote(input, sel, line, american) {
    var q = { game_id: input.game ? input.game.game_id : null, side: sel.side, team: sel.team, line: line, american: american, book: sel.sportsbook,
      captured_at: iso(input.now), fresh: true, market_type: sel.is_main_line ? 'spread' : 'alternate_spread', n_books: 1 };
    var c = qevCtx(input);
    var G = input._evaluation;
    c.main_line_for_side = G && G.main_line ? G.main_line[sel.side] : sel.line;
    return Q().priceQuote(input.model, q, c);
  }
  function clearsAt(input, sel, line, american, cfg) {
    var o = hypoQuote(input, sel, line, american);
    return !!(o && o.ev_available && tailOk(o) && !hasFlag(o, INTEGRITY_FLAGS) && isNum(calEv(o)) && calEv(o) >= cfg.action.min_calibrated_ev - EPS);
  }
  /* the worst whole-cent American price that still clears at `line`
     (cal EV is increasing in the payout, so bisect on the decimal, then
     round toward the bettor: never display a price that fails) */
  function worstPrice(input, sel, line, cfg) {
    var Qx = Q(), hi = Qx.americanToDecimal(cfg.playable.odds_ceiling), lo = 1.0001, i;
    if (!clearsAt(input, sel, line, cfg.playable.odds_ceiling, cfg)) return null;
    var floorDec = Qx.americanToDecimal(cfg.playable.odds_floor);
    if (clearsAt(input, sel, line, cfg.playable.odds_floor, cfg)) return { odds: cfg.playable.odds_floor, floored: true };
    lo = floorDec;
    for (i = 0; i < 50; i++) {
      var mid = (lo + hi) / 2, a = Qx.decimalToAmerican(mid);
      var am = a < 0 ? Math.max(a, -100000) : a;
      if (am > -100 && am < 100) am = am < 0 ? -100.0001 : 100;
      if (clearsAt(input, sel, line, am, cfg)) hi = mid; else lo = mid;
    }
    var a2 = Qx.decimalToAmerican(hi), p = Math.ceil(a2 - 1e-9);
    if (p > -100 && p < 100) p = 100;
    for (i = 0; i < 40 && !clearsAt(input, sel, line, p, cfg); i++) p = p < 0 ? (p + 1 > -100 ? 100 : p + 1) : p + 1;
    return { odds: p, floored: false };
  }
  /* PLAYABLE TO: how far the market can move before the bet is no longer
     valid — spread AND juice together. The corner (worst line, worst price
     at that line) clears; every better line/price clears too (monotone). */
  function playable(input, sel, cfg) {
    if (!sel) return null;
    var P0 = sel.american_odds, L0 = sel.line, maxPts = cfg.playable.max_points, L = L0, frontier = [], k;
    for (k = 1; k <= Math.round(maxPts * 2); k++) {
      var cand = L0 - k * 0.5;
      if (!clearsAt(input, sel, cand, P0, cfg)) break;
      L = cand;
    }
    for (var line = L0; line >= L - EPS; line -= 0.5) {
      var wp = worstPrice(input, sel, r(line, 2), cfg);
      if (wp) frontier.push({ line: r(line, 2), max_odds: wp.odds, floored: wp.floored });
    }
    var corner = frontier.length ? frontier[frontier.length - 1] : null;
    var atCur = frontier.length ? frontier[0] : null;
    var only = !corner || (Math.abs(corner.line - L0) < EPS && atCur && Math.round(atCur.max_odds) === Math.round(P0));
    var team = sel.team || sel.side;
    var text;
    if (only) text = 'CURRENT PRICE ONLY';
    else if (Math.abs(corner.line - L0) < EPS) text = team + ' ' + lineText(L0) + ' or better · maximum ' + priceText(corner.max_odds);
    else text = team + ' ' + lineText(L0) + ' to ' + lineText(corner.line) + ' · up to ' + priceText(corner.max_odds);
    return { mode: only ? 'CURRENT_PRICE_ONLY' : 'RANGE', min_line: corner ? corner.line : L0, max_odds: corner ? corner.max_odds : P0,
      at_current_line_max_odds: atCur ? atCur.max_odds : P0, frontier: frontier, text: text,
      short: only ? 'CURRENT PRICE ONLY' : lineText(corner.line) + ' / ' + priceText(corner.max_odds),
      threshold_calibrated_ev: cfg.action.min_calibrated_ev,
      basis: 'The worst quote at which the calibrated EV still clears ' + pctText(cfg.action.min_calibrated_ev) + ', holding the rest of the market where it is. If the consensus itself moves, EdgeDesk re-prices every number.' };
  }
  /* BET TRIGGER (for a PASS): what the current market would need to offer */
  function betTrigger(input, ref, cfg) {
    if (!ref || !isNum(ref.line) || !isNum(ref.american_odds)) return null;
    var needLine = null, k;
    for (k = 1; k <= Math.round(cfg.trigger.max_points * 2); k++) {
      var cand = ref.line + k * 0.5;
      if (clearsAt(input, ref, cand, ref.american_odds, cfg)) { needLine = r(cand, 2); break; }
    }
    var wp = worstPrice(input, ref, ref.line, cfg);
    var team = ref.team || ref.side, parts = [];
    if (needLine != null) parts.push(team + ' ' + lineText(needLine) + ' (' + priceText(ref.american_odds) + ')');
    if (wp && !wp.floored) parts.push(team + ' ' + lineText(ref.line) + ' (' + priceText(wp.odds) + ')');
    return { line_needed: needLine, price_needed_at_current_line: wp ? wp.odds : null,
      text: parts.length ? 'Would qualify at ' + parts.join(' or ') + ' or better, if the rest of the market stays where it is.' : 'No price within ' + cfg.trigger.max_points + ' points would clear the action threshold.',
      caveat: 'If the whole market moves to that number, the calibrated probability moves with it; EdgeDesk re-evaluates automatically.' };
  }

  /* ============================================================ SIZING
     A weighted composite of everything EXCEPT raw EV and past results. Units
     are the minimum of: the calibrated-EV tier, the requirement tier, the
     composite-score tier and every cap. Always rounded DOWN. */
  function sizingFeatures(input, sel, mq, stab, anomaly, cfg) {
    var R = input.reliability || {}, U = input.projection || {}, I = input.integrity || {}, sup = input.support || {}, G = input.governance || {};
    var gates = I.gates || [];
    var pass = gates.filter(function (g) { return upper(g.status) === 'PASS'; }).length, unk = gates.filter(function (g) { return upper(g.status) !== 'PASS' && upper(g.status) !== 'FAIL'; }).length;
    var age = sel ? num(sel.quote_age_minutes) : null;
    var ts = sel ? twoSidedOf(sel, input._priced || []) : { two_sided: false, same_book: false };
    var calMat = upper(input.model && input.model.adjusted && input.model.adjusted.maturity);
    return {
      calibrated_ev: sel ? calEv(sel) : null,
      reliability: num(R.score),
      market_quality: mq,
      stability: stab,
      independent_support: (sel ? supportFor(input, sel.side) : num(sup.independent_count)) || 0,
      uncertainty: num(U.uncertainty_score),
      integrity_completeness: gates.length ? r((pass + 0.5 * unk) / gates.length, 4) : null,
      quote_age_minutes: age,
      two_sided_same_book: !!ts.same_book,
      calibration_maturity: calMat || null,
      tier_validation: (cfg.sizing.validated_tiers || []).slice(),
      qb_certain: !(input.qb && (input.qb.unresolved_critical || input.qb.contested || input.qb.unconfirmed)),
      availability_certain: !(input.availability && (input.availability.major_uncertainty || input.availability.pending || input.availability.uncertain)),
      anomaly_triggered: !!(anomaly && anomaly.triggered),
      anomaly_severe: !!(anomaly && anomaly.severe),
      governance_status: G.policy_status || null
    };
  }
  function compositeScore(f, cfg) {
    var W = cfg.sizing.weights, c = {};
    c.calibrated_ev = isNum(f.calibrated_ev) ? clamp(f.calibrated_ev / 0.07, 0, 1) : 0;
    c.reliability = isNum(f.reliability) ? clamp((f.reliability - 50) / 50, 0, 1) : 0;
    c.market_quality = { VERIFIED: 1, STRONG: 0.8, ACCEPTABLE: 0.55, THIN: 0.25, INVALID: 0 }[f.market_quality] || 0;
    c.stability = { HIGH: 1, MEDIUM: 0.6, UNMEASURED: 0.4, LOW: 0.1 }[f.stability] || 0;
    c.support = clamp(f.independent_support / 3, 0, 1);
    c.uncertainty = isNum(f.uncertainty) ? clamp(1 - f.uncertainty / 100, 0, 1) : 0.5;
    c.integrity = isNum(f.integrity_completeness) ? f.integrity_completeness : 0.5;
    c.quote_quality = (isNum(f.quote_age_minutes) ? clamp(1 - f.quote_age_minutes / 360, 0.3, 1) : 0.3) * (f.two_sided_same_book ? 1 : 0.8);
    c.calibration = f.calibration_maturity === 'VALIDATED' || f.calibration_maturity === 'PRODUCTION' ? 1 : (f.calibration_maturity ? 0.6 : 0.3);
    c.validation = f.tier_validation && f.tier_validation.length ? 1 : 0.4;
    var total = 0, k;
    for (k in W) if (has(W, k)) total += W[k] * (c[k] || 0);
    return { score: r(100 * total, 1), components: c, weights: copy(W) };
  }
  function sizing(input, sel, mq, stab, anomaly, warnings, cfg) {
    var f = sizingFeatures(input, sel, mq, stab, anomaly, cfg), S = cfg.sizing, comp = compositeScore(f, cfg);
    var material = warnings.filter(function (w) { return S.material_warnings.indexOf(w.code) >= 0; });
    var trail = [];
    function allows(t, ignoreValidation) {
      var why = [];
      if (!(isNum(f.calibrated_ev) && f.calibrated_ev >= t.min_calibrated_ev - EPS)) why.push('calibrated EV below ' + pctText(t.min_calibrated_ev));
      if (!(isNum(f.reliability) && f.reliability >= t.min_reliability)) why.push('reliability below ' + t.min_reliability);
      if ((MQ_ORDER[f.market_quality] || 0) < MQ_ORDER[t.min_market_quality]) why.push('market quality below ' + t.min_market_quality);
      if ((STAB_ORDER[f.stability] || 0) < STAB_ORDER[t.min_stability]) why.push('stability below ' + t.min_stability);
      if (f.independent_support < t.min_support) why.push('fewer than ' + t.min_support + ' independent supporting signals');
      if (comp.score < t.min_score) why.push('composite ' + comp.score + ' below ' + t.min_score);
      if (!t.allow_material_warnings && material.length) why.push('material warning: ' + material.map(function (w) { return w.code; }).join(', '));
      if (t.require_qb_certain && !f.qb_certain) why.push('quarterback not certain');
      if (t.require_availability_certain && !f.availability_certain) why.push('availability not certain');
      if (t.require_no_anomaly && f.anomaly_triggered) why.push('anomaly review triggered');
      if (!ignoreValidation && t.require_tier_validation && (S.validated_tiers || []).indexOf(t.units) < 0) why.push('this tier has no live validation yet (shadow only)');
      if (!ignoreValidation) trail.push({ units: t.units, allowed: !why.length, why: why });
      return !why.length;
    }
    var units = 0, shadow = 0, strength = null;
    S.tiers.forEach(function (t) {
      if (allows(t)) { units = t.units; strength = t.strength; }
      if (allows(t, true)) shadow = Math.min(t.units, S.max_units);
    });
    /* SHADOW units: what the rules would size if every tier were validated —
       recorded for the per-tier record, never recommended */
    var caps = [];
    var maxActive = (S.validated_tiers || []).indexOf(S.max_units) >= 0 ? S.max_units : S.max_active_units_unvalidated;
    if (units > maxActive + EPS) { caps.push('unvalidated tier cap ' + unitsText(maxActive)); units = maxActive; }
    if (anomaly && anomaly.triggered && anomaly.cleared && units > cfg.anomaly.cleared_unit_cap + EPS) { caps.push('anomaly cap ' + unitsText(cfg.anomaly.cleared_unit_cap)); units = cfg.anomaly.cleared_unit_cap; }
    if (anomaly && anomaly.severe && units > cfg.anomaly.severe_unit_cap + EPS) { caps.push('severe-extreme cap ' + unitsText(cfg.anomaly.severe_unit_cap)); units = cfg.anomaly.severe_unit_cap; }
    if (units > S.max_units) units = S.max_units;
    if (shadow > units + EPS && !caps.length) caps.push('unvalidated tier cap: ' + unitsText(shadow) + ' is shadow-only until that tier has live validation');
    var tierOf = S.tiers.filter(function (t) { return Math.abs(t.units - units) < EPS; })[0];
    if (tierOf) strength = tierOf.strength;
    if (units <= 0) strength = null;
    return { units: units, shadow_units: shadow, strength: strength, composite: comp, features: f, tiers: trail, caps: caps,
      validation: (S.validated_tiers || []).length ? 'TIERS_VALIDATED:' + S.validated_tiers.join(',') : UNVALIDATED };
  }

  /* ========================================================== WARNINGS */
  function warningsOf(input, sel, mq, stab, anomaly, cfg) {
    var w = [], qb = input.qb || {}, av = input.availability || {}, X = input.anomaly || {}, g = input.game || {};
    function add(code, text) { w.push({ code: code, text: text }); }
    add('RULES_UNVALIDATED', 'Decision thresholds and stake tiers are conservative defaults, not yet validated on live results.');
    var cm = input.model && input.model.adjusted && input.model.adjusted.maturity;
    if (cm && upper(cm) !== 'VALIDATED') add('CALIBRATION_' + upper(cm), 'The probability calibration is ' + upper(cm) + ' (' + (input.model.adjusted.version || 'unversioned') + ').');
    if (qb.unconfirmed && !qb.unresolved_critical) add('QB_UNCONFIRMED', 'A starting quarterback is expected but not confirmed.');
    if (qb.contested) add('QB_CONTESTED', 'A quarterback situation is contested.');
    if (av.uncertain && !av.major_uncertainty) add('AVAILABILITY_UNCERTAIN', 'Availability data is incomplete.');
    if (mq === 'ACCEPTABLE' || mq === 'THIN') add('SINGLE_BOOK', 'Only one fresh book prices both sides of this number.');
    if (stab === 'UNMEASURED') add('STABILITY_UNMEASURED', 'Projection stability was not measured.');
    if (upper(X.rating_divergence_band) === 'LARGE') add('LARGE_RATING_DIVERGENCE', 'The current rating and the pricing state disagree about this matchup.');
    if (X.fcs || g.fcs) add('FCS_GAME', 'An FCS team is involved.');
    if (anomaly && anomaly.triggered && anomaly.cleared) add('ANOMALY_CLEARED', 'The edge triggered anomaly review; every check cleared, and the stake is capped.');
    if (sel && !sel.is_main_line) add(sel.tail && sel.tail.status === 'VALIDATED' ? 'ALT_LINE' : 'ALT_LINE_TAIL', 'The selected quote is an alternate line.');
    if (input.limits_unknown !== false) add('LIMITS_UNKNOWN', 'Sportsbook stake limits are not published to EdgeDesk; the edge is quoted per unit.');
    return w;
  }
  function invalidationOf(input, sel, pl) {
    var out = [];
    if (pl && pl.mode === 'RANGE') {
      out.push({ code: 'LINE', text: 'line worse than ' + lineText(pl.min_line) });
      out.push({ code: 'PRICE', text: 'price worse than ' + priceText(pl.max_odds) + (Math.abs(pl.min_line - sel.line) > EPS ? ' at ' + lineText(pl.min_line) : '') });
    } else if (sel) out.push({ code: 'PRICE', text: 'any line or price worse than ' + lineText(sel.line) + ' (' + priceText(sel.american_odds) + ')' });
    out.push({ code: 'QB', text: 'material QB change' });
    out.push({ code: 'AVAILABILITY', text: 'significant injury/availability update' });
    out.push({ code: 'MARKET', text: 'market verification failure or the consensus moving through the number' });
    out.push({ code: 'STABILITY', text: 'projection instability' });
    out.push({ code: 'INTEGRITY', text: 'model integrity failure' });
    out.push({ code: 'KICKOFF', text: 'kickoff (pregame decisions close)' });
    return out;
  }

  /* ============================================================ DECIDE */
  function skeleton(input, cfg) {
    var g = input.game || {}, M = input.market || {}, R = input.research || {}, Rl = input.reliability || {}, Cf = input.confidence || {}, P = input.projection || {};
    var mk = marketKey(input);
    var fm = input.model ? num(input.model.fair_home_margin) : null, ch = num(M.consensus_home_line);
    /* side-neutral texts (a NO DECISION card still shows the projection and the reference market) */
    var fairText = fm == null ? null : (Math.abs(fm) < 0.05 ? 'Pick’em' : (fm > 0 ? g.home : g.away) + ' -' + Math.abs(fm).toFixed(1));
    var consText = ch == null ? null : (Math.abs(ch) < 0.05 ? 'Pick’em' : (ch < 0 ? g.home : g.away) + ' -' + Math.abs(ch).toFixed(1).replace(/\.0$/, ''));
    return {
      schema: VERSION, decision_engine_version: VERSION, config_version: cfg.version, validation_state: cfg.validation_state,
      game_id: g.game_id != null ? String(g.game_id) : null, sport: upper(input.sport || (input.model && input.model.sport) || null), market_key: mk,
      home: g.home || null, away: g.away || null, kickoff: iso(g.kickoff),
      decision: 'NO_DECISION', decision_label: DECISIONS.NO_DECISION.label, decision_tone: DECISIONS.NO_DECISION.tone, headline: DECISIONS.NO_DECISION.headline,
      action_reason_code: null, action_reason_text: null,
      side: null, side_key: null, market_type: input.market_type || 'spread', selected_line: null, selected_odds: null, selected_book: null, selected_is_alternate: false,
      recommended_units: 0, shadow_units: 0, strength: null, strength_label: null,
      recommended_dollars: null, unit_value: null,
      max_playable_line: null, max_acceptable_odds: null, playable: null,
      model_fair_line: null, model_fair_text: fairText, consensus_market_line: null, consensus_text: consText, model_market_gap: num(R.gap_pts),
      market_movement_pts: num(M.movement_pts),
      best_available: null, bet_price: null, reference_quote: null,
      cover_probability: null, push_probability: null, break_even_probability: null, calibrated_cover_probability: null,
      raw_ev_pct: null, calibrated_ev_pct: null, risk_adjusted_score: null,
      reliability_score: num(Rl.score), reliability_label: Rl.grade || Rl.label || null,
      confidence_score: num(Cf.score), confidence_label: Cf.label || null,
      projection_stability: null, market_quality: null, independent_support_count: null,
      research_status: R.status || null, research_label: R.label || null,
      blockers: [], warnings: [], invalidation_conditions: [], waiting_on: [], next_check: null, bet_trigger: null,
      alternatives: null, anomaly: null, sizing: null,
      first_qualified_at: null, evaluated_at: iso(input.now), quote_captured_at: null,
      model_version: input.model ? input.model.model_version || null : null,
      pricing_model_version: (function () { try { return Q().VERSION; } catch (e) { return null; } })(),
      calibration_version: input.model && input.model.adjusted ? input.model.adjusted.version || null : null,
      governance: input.governance ? copy(input.governance) : null,
      projection: P.projected_home != null || P.p50 != null ? { home_points: num(P.projected_home), away_points: num(P.projected_away), p10: num(P.p10), p50: num(P.p50), p90: num(P.p90) } : null,
      transition: null
    };
  }
  function finish(out, code, cls, extra) {
    var c = cls || (REASONS[code] ? REASONS[code][0] : 'NO_DECISION'), D = DECISIONS[c];
    out.decision = c; out.decision_label = D.label; out.decision_tone = D.tone; out.headline = D.headline;
    out.action_reason_code = code; out.action_reason_text = reasonText(code) + (extra ? ' ' + extra : '');
    if (c !== 'BET') { out.recommended_units = 0; out.strength = null; out.strength_label = null; out.playable = null; out.max_playable_line = null; out.max_acceptable_odds = null; out.recommended_dollars = null; }
    out.decision_id = 'bd_' + hash([out.game_id, out.market_key, out.decision, out.action_reason_code, out.side_key, out.selected_line, out.selected_odds, out.selected_book, out.recommended_units, out.evaluated_at, out.model_version, out.calibration_version]);
    return out;
  }
  function block(out, code, text, cls) { out.blockers.push({ code: code, text: text || reasonText(code), class: cls || (REASONS[code] ? REASONS[code][0] : 'NO_DECISION') }); }
  function attachQuote(out, input, o, asSelection) {
    if (!o) return;
    out.side = o.team || teamOf(input, o.side); out.side_key = o.side;
    out.market_type = o.market_type === 'alternate_spread' ? 'spread' : (o.market_type || 'spread');
    out.selected_line = o.line; out.selected_odds = o.american_odds; out.selected_book = o.sportsbook; out.selected_is_alternate = !o.is_main_line;
    out.quote_captured_at = o.captured_at;
    out.cover_probability = o.model_cover_probability; out.push_probability = o.model_push_probability; out.break_even_probability = o.break_even_probability;
    out.calibrated_cover_probability = calCover(o);
    out.raw_ev_pct = isNum(o.expected_value) ? r(100 * o.expected_value, 2) : null;
    out.calibrated_ev_pct = isNum(calEv(o)) ? r(100 * calEv(o), 2) : null;
    out.risk_adjusted_score = r(riskAdjusted(o), 5);
    out.independent_support_count = supportFor(input, o.side);
    var f = fairLineForSide(input, o.side);
    out.model_fair_line = f; out.model_fair_text = f == null ? null : out.side + ' ' + lineText(r(f, 1));
    var mh = input.market ? num(input.market.consensus_home_line) : null;
    out.consensus_market_line = mh == null ? null : (o.side === 'home' ? mh : -mh);
    out.consensus_text = mh == null ? null : out.side + ' ' + lineText(out.consensus_market_line);
    if (asSelection) out.bet_price = quoteSummary(o); else out.reference_quote = quoteSummary(o);
  }
  function hint(input, priced, cfg) {
    /* raw signal only: decides WAIT vs NO_DECISION when the market cannot be trusted */
    var R = input.research || {}, gap = num(R.gap_pts);
    var toward = R.gap_toward_side || null;
    var best = null;
    priced.forEach(function (o) { if (isNum(o.expected_value) && o.is_main_line && (!toward || o.side === toward) && (!best || o.expected_value > best.expected_value)) best = o; });
    var rawOk = best && best.expected_value >= cfg.wait.min_raw_ev;
    return { attractive: !!(rawOk && gap != null && gap >= cfg.wait.min_gap_pts - EPS), quote: best };
  }
  function pricedIncludingStale(G) { return allPriced(G); }

  function decide(input, over) {
    /* a shallow copy: the working fields (_evaluation, _priced) never touch the caller's object */
    input = Object.assign({}, input || {});
    var cfg = over && over.version === CONFIG_VERSION && Object.isFrozen && Object.isFrozen(over) ? over : config(over);
    var out = skeleton(input, cfg);
    var g = input.game || {}, I = input.integrity || {}, R = input.research || {}, M = input.market || {};
    var mk = cfg.markets[out.market_key] || { supported: false, bet_authority: 'NONE', calibration_required: true };
    var prevDecision = input.previous ? input.previous.decision : null;

    /* ---- 1. GAME STATE ---- */
    var st = gameState(input);
    if (!out.game_id) { block(out, 'INVALID_GAME'); return finish(out, 'INVALID_GAME'); }
    if (st === 'CANCELED' || st === 'CANCELLED') { block(out, 'GAME_CANCELLED'); return finish(out, 'GAME_CANCELLED'); }
    if (st === 'POSTPONED') { block(out, 'GAME_POSTPONED'); return finish(out, 'GAME_POSTPONED'); }
    if (st === 'SUSPENDED') { block(out, 'GAME_SUSPENDED'); return finish(out, 'GAME_SUSPENDED'); }
    var ko = ms(g.kickoff), now = ms(input.now);
    if (st === 'IN_PROGRESS' || st === 'FINAL' || st === 'FINISHED' || (ko != null && now != null && now >= ko)) { block(out, 'GAME_STARTED'); return finish(out, 'GAME_STARTED'); }
    if (g.duplicate) { block(out, 'DUPLICATE_GAME'); return finish(out, 'DUPLICATE_GAME'); }
    if (g.mapping_ok === false) { block(out, 'INVALID_GAME', 'The teams did not resolve to one event.'); return finish(out, 'INVALID_GAME'); }
    if (!mk.supported) { block(out, 'UNSUPPORTED_MARKET'); return finish(out, 'UNSUPPORTED_MARKET'); }

    /* ---- 2. INTEGRITY ---- */
    if (I.data_fault || R.status === 'DATA_FAULT') { block(out, 'DATA_FAULT', I.data_fault_reason || R.reason || null); return finish(out, 'DATA_FAULT'); }
    if (g.orientation_ok === false) { block(out, 'ORIENTATION_FAULT', g.orientation_reason || null); return finish(out, 'ORIENTATION_FAULT'); }
    if (!input.model || !input.model.available) { block(out, 'MODEL_UNAVAILABLE', input.model && input.model.reason || null); return finish(out, 'MODEL_UNAVAILABLE'); }
    if (I.malformed_projection) { block(out, 'MALFORMED_PROJECTION', I.malformed_reason || null); return finish(out, 'MALFORMED_PROJECTION'); }
    if (I.self_check_ok === false) { block(out, 'SELF_CHECK_FAILED', I.self_check_reason || null); return finish(out, 'SELF_CHECK_FAILED'); }
    var conf = input.confidence ? num(input.confidence.score) : null;
    var confRequired = !input.confidence || input.confidence.required !== false;
    if (confRequired && (conf == null || conf < cfg.action.min_confidence)) { block(out, 'INSUFFICIENT_MODEL_DATA', 'Football confidence ' + (conf == null ? 'is unmeasured' : Math.round(conf) + ' is under the ' + cfg.action.min_confidence + ' floor') + '.'); return finish(out, 'INSUFFICIENT_MODEL_DATA'); }

    /* ---- 3. MARKET QUALITY (before calibration: the calibrator is anchored
       at a fresh market line, so without one its absence is a market fact) ---- */
    var G = null;
    try { G = evaluation(input); } catch (e) { block(out, 'NO_VALID_QUOTE', 'pricing failed: ' + String(e && e.message || e).slice(0, 120)); return finish(out, 'NO_VALID_QUOTE'); }
    input._evaluation = G;
    var priced = allPriced(G);
    input._priced = priced;
    var avail = priced.filter(function (o) { return o.ev_available; });
    var H = hint(input, avail, cfg);
    if (!priced.length || M.available === false) { block(out, 'NO_MARKET'); return finish(out, 'NO_MARKET'); }
    if (!avail.length) {
      var codes = priced.map(function (o) { return o.ev_unavailable_code; });
      if (codes.indexOf('STALE') >= 0 || M.stale) {
        if (prevDecision === 'BET' || prevDecision === 'WAIT') {
          if (input.previous && input.previous.bet_price) out.reference_quote = input.previous.bet_price;
          out.waiting_on.push({ code: 'QUOTE_REFRESH', text: 'a fresh quote at the evaluated number' });
          out.next_check = 'Automatically re-evaluates when a fresh quote arrives.';
          block(out, 'QUOTE_REFRESH_PENDING', null, 'WAIT');
          return finish(out, 'QUOTE_REFRESH_PENDING');
        }
        block(out, 'STALE_QUOTE'); return finish(out, 'STALE_QUOTE');
      }
      if (codes.indexOf('ORIENTATION') >= 0) { block(out, 'ORIENTATION_FAULT'); return finish(out, 'ORIENTATION_FAULT'); }
      if (codes.indexOf('MARKET_INTEGRITY') >= 0) { block(out, 'MARKET_FAULT'); return finish(out, 'MARKET_FAULT'); }
      if (codes.indexOf('DATA_FAULT') >= 0) { block(out, 'DATA_FAULT'); return finish(out, 'DATA_FAULT'); }
      block(out, 'NO_VALID_QUOTE', G && G.ev_unavailable_reason || null); return finish(out, 'NO_VALID_QUOTE');
    }
    if (M.suspended) {
      if (H.attractive) { attachQuote(out, input, H.quote, false); out.waiting_on.push({ code: 'LINE_BACK', text: 'the line returning to the board' }); out.next_check = 'Automatically re-evaluates when the line is re-posted.'; block(out, 'LINE_SUSPENDED', null, 'WAIT'); return finish(out, 'LINE_SUSPENDED'); }
      block(out, 'NO_VALID_QUOTE', 'the line is off the board'); return finish(out, 'NO_VALID_QUOTE');
    }
    /* the two sides' main lines must mirror: otherwise the side mapping or the sign is wrong */
    if (mirrorFault(priced)) { block(out, 'ORIENTATION_FAULT', 'a book’s two sides do not mirror'); return finish(out, 'ORIENTATION_FAULT'); }
    var twoSidedAny = avail.some(function (o) { return twoSidedOf(o, priced).two_sided; });
    if (cfg.action.require_two_sided && !twoSidedAny) {
      if (H.quote) attachQuote(out, input, H.quote, false);
      block(out, 'NO_TWO_SIDED_MARKET'); return finish(out, 'NO_TWO_SIDED_MARKET');
    }
    if (M.fault || R.status === 'MARKET_FAULT') {
      if (H.attractive) { attachQuote(out, input, H.quote, false); out.waiting_on.push({ code: 'MARKET_REVERIFY', text: 'market re-verification (' + (M.fault_reason || R.reason || 'market integrity') + ')' }); out.next_check = 'Automatically re-evaluates when verified market data arrives.'; block(out, 'MARKET_FAULT_UNDER_REVIEW', M.fault_reason || null, 'WAIT'); return finish(out, 'MARKET_FAULT_UNDER_REVIEW'); }
      block(out, 'MARKET_FAULT', M.fault_reason || R.reason || null); return finish(out, 'MARKET_FAULT');
    }
    if (R.status === 'INVESTIGATE' || R.verification === 'FAILED' || (num(R.gap_pts) != null && R.gap_pts >= cfg.anomaly.gap_pts && R.verification === 'INCOMPLETE')) {
      if (H.attractive) {
        attachQuote(out, input, H.quote, false);
        out.waiting_on.push({ code: 'MARKET_VERIFICATION', text: 'market verification' + ((R.verification_items || []).length ? ' (' + R.verification_items.slice(0, 3).join('; ') + ')' : '') });
        out.next_check = 'Automatically re-evaluates when verified market data arrives.';
        block(out, 'MARKET_VERIFICATION_PENDING', null, 'WAIT'); return finish(out, 'MARKET_VERIFICATION_PENDING');
      }
      block(out, 'UNVERIFIED_LARGE_GAP'); return finish(out, 'UNVERIFIED_LARGE_GAP');
    }

    /* ---- 4. CALIBRATION ---- */
    var calOk = !!(input.model.adjusted && input.model.adjusted.available);
    if (mk.calibration_required && !calOk) {
      block(out, 'CALIBRATION_UNAVAILABLE', input.model.adjusted && input.model.adjusted.reason || null);
      /* the raw arithmetic stays available for research, never as a decision */
      if (H.quote || (G && G.best_ev_quote)) attachQuote(out, input, H.quote || G.best_ev_quote, false);
      return finish(out, 'CALIBRATION_UNAVAILABLE');
    }

    /* ---- 5. PRICE: every quote priced; pick the candidate ---- */
    var S = selectQuote(avail.filter(function (o) { return twoSidedOf(o, priced).two_sided; }), cfg);
    var sel = S.recommended, ref = S.reference;
    if (!sel && !ref) { block(out, 'NO_VALID_QUOTE', 'no two-sided quote with a calibrated price'); return finish(out, 'NO_VALID_QUOTE'); }
    var cand = sel || ref;
    attachQuote(out, input, cand, !!sel);
    var bestSide = cand.side, BS = G.sides[bestSide];
    if (BS && BS.best_line) out.best_available = quoteSummary(BS.best_line);
    var mq = marketQuality(input, cand, priced, cfg), stab = stabilityOf(input);
    out.market_quality = mq; out.projection_stability = stab;
    var anomaly = anomalyReview(input, cand, priced, G, cfg);
    out.anomaly = anomaly;
    var attractive = !!sel;

    /* ---- 6. INFORMATION (WAIT only when the price is attractive) ---- */
    var qb = input.qb || {}, av = input.availability || {};
    var pending = [];
    if (qb.unresolved_critical) pending.push(['QB_UNRESOLVED', { code: 'QB_CONFIRMATION', text: 'QB confirmation' + (qb.detail ? ' (' + qb.detail + ')' : '') }]);
    /* an unknown QB state is unresolved information, never a clean bill */
    else if (qb.known === false) pending.push(['QB_UNRESOLVED', { code: 'QB_STATUS_DATA', text: 'quarterback status data (not loaded for this game)' }]);
    if (av.major_uncertainty || av.pending) pending.push(['AVAILABILITY_PENDING', { code: 'AVAILABILITY_UPDATE', text: 'availability update' + (av.detail ? ' (' + av.detail + ')' : '') }]);
    if (pending.length && attractive) {
      pending.forEach(function (p) { out.waiting_on.push(p[1]); block(out, p[0], null, 'WAIT'); });
      out.next_check = 'Automatically re-evaluates when the information resolves; the decision is recomputed on the new projection.';
      out.warnings = warningsOf(input, cand, mq, stab, anomaly, cfg);
      return finish(out, pending[0][0]);
    }

    /* ---- 7. ANOMALY REVIEW (a big edge gets more scrutiny) ---- */
    if (anomaly.triggered && !anomaly.cleared && attractive) {
      var open = anomaly.checks.filter(function (c) { return c.status !== 'PASS'; });
      out.waiting_on.push({ code: 'ANOMALY_REVIEW', text: 'anomaly review: ' + open.map(function (c) { return c.code.replace(/_/g, ' ').toLowerCase() + ' ' + c.status.toLowerCase(); }).join('; ') });
      out.next_check = 'Automatically re-evaluates as the open checks resolve.';
      out.warnings = warningsOf(input, cand, mq, stab, anomaly, cfg);
      block(out, 'ANOMALY_REVIEW', null, 'WAIT'); return finish(out, 'ANOMALY_REVIEW');
    }

    /* ---- 8. CALIBRATED ADVANTAGE ---- */
    out.warnings = warningsOf(input, cand, mq, stab, anomaly, cfg);
    if (pending.length) pending.forEach(function (p) { out.warnings.push({ code: p[0], text: reasonText(p[0]) }); });
    if (!sel) {
      var ce = calEv(ref), re = ref.expected_value, code;
      var pb0 = input.previous && input.previous.bet_price;
      var samePrice = pb0 && pb0.side === ref.side && Math.abs(num(pb0.line) - ref.line) < EPS && Math.round(num(pb0.odds)) === Math.round(ref.american_odds);
      if (prevDecision === 'BET' && samePrice) code = 'PROJECTION_CHANGED';
      else if (prevDecision === 'BET') code = 'PRICE_MOVED';
      else if (S.tail_only) code = 'ALT_TAIL_ONLY';
      else if (ce > 0) code = 'CALIBRATED_EV_BELOW_THRESHOLD';
      else if (isNum(re) && re > 0) code = 'CALIBRATED_EV_NEGATIVE';
      else code = 'NO_MODEL_EDGE';
      var moved = '';
      if (code === 'PRICE_MOVED' && input.previous && input.previous.bet_price) {
        var pb = input.previous.bet_price;
        moved = 'Line moved from ' + lineText(pb.line) + ' (' + priceText(pb.odds) + ') to ' + lineText(ref.line) + ' (' + priceText(ref.american_odds) + ') and crossed EdgeDesk’s playable threshold.';
      }
      block(out, code, moved || null, 'PASS');
      out.bet_trigger = betTrigger(input, ref, cfg);
      return finish(out, code, 'PASS', moved || null);
    }

    /* ---- 9. RELIABILITY / STABILITY / MARKET QUALITY ---- */
    var rel = input.reliability ? num(input.reliability.score) : null;
    if (rel == null && (!input.reliability || input.reliability.required !== false)) { block(out, 'RELIABILITY_UNMEASURED'); return finish(out, 'RELIABILITY_UNMEASURED'); }
    if (rel != null && rel < cfg.action.min_reliability) { block(out, 'LOW_RELIABILITY', 'Reliability ' + Math.round(rel) + ' is under ' + cfg.action.min_reliability + '.', 'PASS'); out.bet_trigger = null; return finish(out, 'LOW_RELIABILITY', 'PASS'); }
    if (cfg.action.reject_low_stability && stab === 'LOW') { block(out, 'UNSTABLE_PROJECTION', null, 'PASS'); return finish(out, 'UNSTABLE_PROJECTION', 'PASS'); }
    if ((MQ_ORDER[mq] || 0) < MQ_ORDER[cfg.action.min_market_quality]) { block(out, 'THIN_MARKET', 'Market quality ' + mq + '.', 'PASS'); return finish(out, 'THIN_MARKET', 'PASS'); }

    /* ---- 10. RISK SIZING ---- */
    var Z = sizing(input, sel, mq, stab, anomaly, out.warnings, cfg);
    out.sizing = Z; out.shadow_units = Z.shadow_units;
    if (!(Z.units > 0)) { block(out, 'SIZING_ZERO', Z.tiers.length ? Z.tiers[0].why.join('; ') : null, 'PASS'); return finish(out, 'SIZING_ZERO', 'PASS'); }

    /* ---- governance: who holds BET authority for this market ---- */
    var gov = input.governance || {};
    if (mk.bet_authority === 'GOVERNED_POLICY' && gov.policy_bet_enabled !== true) { block(out, 'BET_AUTHORITY_DISABLED', null, 'PASS'); return finish(out, 'BET_AUTHORITY_DISABLED', 'PASS'); }
    if (mk.bet_authority === 'NONE') { block(out, 'UNSUPPORTED_MARKET'); return finish(out, 'UNSUPPORTED_MARKET'); }

    /* ---- BET ---- */
    out.recommended_units = Z.units;
    out.strength = Z.strength; out.strength_label = Z.strength ? STRENGTH[Z.strength].label : null;
    var pl = playable(input, sel, cfg);
    out.playable = pl; out.max_playable_line = pl ? pl.min_line : sel.line; out.max_acceptable_odds = pl ? pl.max_odds : sel.american_odds;
    out.invalidation_conditions = invalidationOf(input, sel, pl);
    out.alternatives = S.alternatives ? { main: quoteSummary(S.alternatives.main), safer: quoteSummary(S.alternatives.safer), better_value: quoteSummary(S.alternatives.better_value), aggressive: quoteSummary(S.alternatives.aggressive),
      note: 'SAFER means a higher calibrated cover probability; BETTER VALUE means a higher calibrated EV. They are different questions. The recommendation is the best calibrated EV per unit of risk.' } : null;
    out.first_qualified_at = input.track && input.track.first_qualified ? input.track.first_qualified.at : out.evaluated_at;
    return finish(out, 'QUALIFIES', 'BET');
  }

  /* ============================================================ TEXT */
  function actionLine(d) {
    if (!d) return '';
    if (d.decision === 'BET') return 'BET · ' + unitsText(d.recommended_units);
    return d.decision_label;
  }
  function selectionText(d) {
    if (!d || d.selected_line == null && !d.reference_quote) return null;
    if (d.decision === 'BET') return d.side + ' ' + lineText(d.selected_line) + ' (' + priceText(d.selected_odds) + ')';
    var q = d.reference_quote || d.bet_price;
    return q ? (q.team || q.side) + ' ' + lineText(q.line) + ' (' + priceText(q.odds) + ')' : null;
  }
  function oneSentence(d) {
    if (!d) return '';
    if (d.decision === 'BET') return 'Current price clears EdgeDesk’s calibrated edge and reliability requirements.';
    return d.action_reason_text || '';
  }

  return {
    VERSION: VERSION, CONFIG_VERSION: CONFIG_VERSION, UNVALIDATED: UNVALIDATED, DEFAULT_CONFIG: deepFreeze(copy(DEFAULT_CONFIG)),
    DECISIONS: deepFreeze(copy(DECISIONS)), DECISION_KEYS: DECISION_KEYS, STRENGTH: deepFreeze(copy(STRENGTH)), REASONS: deepFreeze(copy(REASONS)), TOOLTIP: deepFreeze(copy(TOOLTIP)),
    INTEGRITY_FLAGS: INTEGRITY_FLAGS, MAGNITUDE_FLAGS: MAGNITUDE_FLAGS,
    config: config, decide: decide,
    /* parts, exposed for tests and the page (no new arithmetic in any of them) */
    selectQuote: selectQuote, playable: playable, betTrigger: betTrigger, sizing: sizing, compositeScore: compositeScore, anomalyReview: anomalyReview,
    marketQuality: marketQuality, stabilityOf: stabilityOf, twoSidedOf: twoSidedOf, quoteDispersion: quoteDispersion, mirrorFault: mirrorFault, riskAdjusted: riskAdjusted, returnSd: returnSd, quoteSummary: quoteSummary,
    reasonText: reasonText, actionLine: actionLine, selectionText: selectionText, oneSentence: oneSentence,
    lineText: lineText, priceText: priceText, pctText: pctText, unitsText: unitsText, hash: hash
  };
}));

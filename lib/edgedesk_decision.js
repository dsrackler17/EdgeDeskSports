/* ===========================================================================
   EDGEDESK FOOTBALL DECISION ENGINE — one wager decision per game and market,
   for the NFL and for college football, from ONE framework.
   docs/bettor-decision/DESIGN.md

   EdgeDesk has several engines that each answer a narrower question:

     research status   how interesting is this matchup?   (lib/edgedesk_canon.js)
     quote EV          what is THIS exact quote worth?    (lib/edgedesk_quote_ev.js)
     EV read / policy  calibrated EV, circuit breaker     (lib/edgedesk_ev.js)
     governed engine   cfb_decision_policy_v1 (SHADOW)    (football/cfb_decision)

   This file reads their outputs and answers the bettor's question — is there
   a wager worth taking at this exact price? — in TWO SEPARATE LAYERS:

   LAYER A · CAN WE EVALUATE?  (evaluation_status EVALUABLE / NOT_EVALUABLE)
     Essential data only: a valid game identity, a resolvable home/away
     orientation, a model projection with an outcome distribution, a current
     priced quote inside the freshness limit, sane odds and probabilities.
     A failure here is the ONLY road to NO DECISION, and it always names its
     blocker code. Missing OPTIONAL data (calibration maturity, reliability,
     personnel, coaching validation, a short live record) never lands here.

   LAYER B · SHOULD WE BET?  BET / LEAN / WATCH / PASS
     Every quote on both sides (main and alternate) is priced by EDQuoteEV and
     classified at its own line and price. The recommendation is the best
     RISK-ADJUSTED actionable quote, then capped by uncertainty:
       MISSING OPTIONAL DATA  = lower decision confidence, smaller stake, a cap
       SUSPICIOUS, NOT BROKEN = WATCH · PRICE ANOMALY (never BET, never NO DECISION)
       MISSING ESSENTIAL DATA = NO DECISION (Layer A)

   PROBABILITY SOURCE (decision priority; always printed with the decision)
     1. calibrated            live-validated calibration
     2. partially_calibrated  an out-of-sample calibrator (CFB, SHADOW) or a
                              held-out-validated market blend (NFL pricing
                              blend, tier LEAN) — not yet validated live
     3. model_estimated       the raw model probability (UNVALIDATED
                              CALIBRATION): still judged, with less confidence
                              and a smaller maximum stake

   WHAT THIS FILE NEVER DOES
     - compute a football number. Probabilities come from EDQuoteEV.priceQuote
       on the model object the page/build built; the NFL blend below only moves
       the CENTRE of the league's own learned margin distribution, with the
       coefficients football/validation/pricing_nfl.json fitted out of sample.
     - read a past result. Sizing has no input for wins, losses or streaks.
     - let raw EV, a model-market gap or a research status produce BET by
       themselves. A research status is interest; a decision is price.
     - recommend more than 1.00U. Every threshold is a configurable,
       CONSERVATIVE_DEFAULT_UNVALIDATED constant (DEFAULT_CONFIG below).

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

  var VERSION = 'edgedesk_football_decision_v2';
  var CONFIG_VERSION = 'football_decision_config_v2.1';

  var Qm = null, Vm = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) {
    try { Qm = require('./edgedesk_quote_ev.js'); } catch (e) { Qm = null; }
    try { Vm = require('./edgedesk_vocab.js'); } catch (e) { Vm = null; }
  }
  /* THE WORDS: one vocabulary for every surface (lib/edgedesk_vocab.js) */
  var VOC = Vm || (root && root.EDVocab) || null;
  if (!VOC) throw new Error('EDDecision needs lib/edgedesk_vocab.js (EDVocab) loaded first');
  function Q() {
    var q = Qm || (root && root.EDQuoteEV);
    if (!q || typeof q.priceQuote !== 'function') throw new Error('EDDecision needs lib/edgedesk_quote_ev.js (EDQuoteEV) loaded first');
    return q;
  }
  /* the canonical market (lib/edgedesk_market.js) and the execution layer
     (lib/edgedesk_execution.js). Both are pure; without them a decision is
     still made, it just carries no canonical market, ladder or execution. */
  var Mm = null, Xm = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) {
    try { Mm = require('./edgedesk_market.js'); } catch (e) { Mm = null; }
    try { Xm = require('./edgedesk_execution.js'); } catch (e) { Xm = null; }
  }
  function MK() { return Mm || (root && root.EDMarket) || null; }
  function EX() { return Xm || (root && root.EDExecution) || null; }

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
  function assign(a) { for (var i = 1; i < arguments.length; i++) { var b = arguments[i]; if (b) for (var k in b) if (has(b, k)) a[k] = b[k]; } return a; }
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
  function probText(x, dp) { return isNum(x) ? (100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function ppText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2).replace(/0$/, '') + 'U' : '—'; }
  function otherSide(s) { return s === 'home' ? 'away' : 'home'; }
  /* a quote's side and number as a bettor reads it: Over 44.5, Chicago Bears ML, Chicago Bears -3 */
  function pickText(ref, team, line) {
    if (ref.market_type === 'total') { var sd = String(ref.side || ''); return sd.charAt(0).toUpperCase() + sd.slice(1) + ' ' + (isNum(line) ? String(Math.round(line * 10) / 10) : '—'); }
    if (ref.market_type === 'moneyline') return team + ' ML';
    return team + ' ' + lineText(line);
  }
  function upper(s) { return s == null ? null : String(s).toUpperCase(); }
  function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function favText(team, homeMargin, home, away) {
    if (!isNum(homeMargin)) return null;
    if (Math.abs(homeMargin) < 0.05) return 'Pick’em';
    return (homeMargin > 0 ? home : away) + ' -' + Math.abs(homeMargin).toFixed(1);
  }

  /* ================================================================ CONFIG
     Every number is configurable and none is validated on live results yet:
     the whole set carries that label, and every decision repeats it. */
  var UNVALIDATED = 'CONSERVATIVE_DEFAULT_UNVALIDATED';
  var DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    validation_state: UNVALIDATED,
    /* markets this engine decides. max_class caps a market whose probability
       infrastructure has no validated skill (totals and moneylines: the
       pricing validation reads them RESEARCH), so it can say LEAN / WATCH /
       PASS but never size a stake. bet_authority: BETTOR_RULES (these rules),
       GOVERNED_POLICY (BET only when the governed policy enables it). */
    markets: {
      'CFB:spread': { supported: true, bet_authority: 'BETTOR_RULES', max_class: 'BET' },
      'NFL:spread': { supported: true, bet_authority: 'BETTOR_RULES', max_class: 'BET' },
      'CFB:total': { supported: true, bet_authority: 'BETTOR_RULES', max_class: 'LEAN' },
      'NFL:total': { supported: true, bet_authority: 'BETTOR_RULES', max_class: 'LEAN' },
      'CFB:moneyline': { supported: true, bet_authority: 'BETTOR_RULES', max_class: 'LEAN' },
      'NFL:moneyline': { supported: true, bet_authority: 'BETTOR_RULES', max_class: 'LEAN' }
    },
    /* league-specific scale: an NFL point is worth far more than a college one */
    leagues: {
      CFB: { major_gap_pts: 7, strong_gap_pts: 3, watch_gap_pts: 2, aligned_gap_pts: 1, outlier_gap_pts: 10, guard_gap_pts: 21,
        sign_flip: { bound: 21, reconcile: 7 }, consensus_tolerance_pts: 1.5, watch_trigger_points: 1.0, watch_trigger_cents: 15 },
      NFL: { major_gap_pts: 4, strong_gap_pts: 1.5, watch_gap_pts: 1, aligned_gap_pts: 0.5, outlier_gap_pts: 7, guard_gap_pts: 14,
        sign_flip: { bound: 12, reconcile: 4 }, consensus_tolerance_pts: 1, watch_trigger_points: 0.5, watch_trigger_cents: 10 }
    },
    /* the price thresholds, on the decision probability (calibrated when it
       exists) at the exact quote. edge = cover − break-even, in points. */
    thresholds: {
      bet: { min_edge_pp: 4.0, min_ev: 0.05 },
      strong: { min_edge_pp: 7.0, min_ev: 0.10 },
      lean: { min_edge_pp: 2.0, min_ev: 0.0 }
      /* WATCH for price: the BET trigger sits within the league's
         watch_trigger_points / watch_trigger_cents of the current quote */
    },
    /* soft floors: below them the class is capped (never NO DECISION) */
    gates: { min_decision_confidence: 40, min_reliability: 60, min_model_confidence: 35, reject_low_stability: true },
    /* extreme numbers get MORE scrutiny, never a bigger stake */
    anomaly: { raw_ev: 0.20, decision_ev: 0.15, edge_pp: 12, move_pts: 3, max_dispersion: 1.5, cleared_unit_cap: 0.50, severe_unit_cap: 0.25 },
    market_quality: { verified_min_books: 2, strong_min_books: 2 },
    freshness: { max_quote_age_minutes: 90, reference_minutes: 180 },
    confidence: {
      weights: { model: 0.14, reliability: 0.14, stability: 0.08, freshness: 0.08, market: 0.12, qb: 0.12, availability: 0.08, calibration: 0.12, consistency: 0.06, anomaly: 0.06 },
      labels: [[80, 'High'], [60, 'Moderate'], [40, 'Low'], [0, 'Very low']]
    },
    sizing: {
      max_units: 1.00,                 /* never above 1.00U */
      grid: [0.25, 0.50, 0.75, 1.00],  /* units are always rounded DOWN onto this grid */
      unit_pct_of_bankroll: 0.01,      /* 1U = 1% of bankroll (EdgeDesk's default unit) */
      kelly_fraction: 0.25,            /* a quarter-Kelly ceiling: long prices size smaller */
      /* the probability source caps the stake until live validation improves */
      source_caps: { calibrated: 1.00, partially_calibrated: 0.50, model_estimated: 0.25 },
      market_caps: { ACCEPTABLE: 0.50 },
      material_cap: 0.25,
      material_warnings: ['LARGE_RATING_DIVERGENCE', 'FCS_GAME', 'QB_CONTESTED', 'QB_UNCONFIRMED', 'AVAILABILITY_UNCERTAIN', 'MODEL_MARKET_OUTLIER', 'ORIENTATION_REPAIRED'],
      tiers: [
        { key: 'SMALL', units: 0.25, min_edge_pp: 4, min_ev: 0.05, min_confidence: 40 },
        { key: 'STANDARD', units: 0.50, min_edge_pp: 4, min_ev: 0.05, min_confidence: 60 },
        { key: 'STRONG', units: 0.75, min_edge_pp: 7, min_ev: 0.10, min_confidence: 70, require_gap: true },
        { key: 'MAX', units: 1.00, min_edge_pp: 7, min_ev: 0.10, min_confidence: 85, require_gap: true, require_source: 'calibrated', require_clean: true, min_market_quality: 'VERIFIED' }
      ]
    },
    playable: { max_points: 3, odds_floor: -250, odds_ceiling: 1000 },
    /* a BET trigger is searched up to max_points away; it is only NAMED to a
       reader when it is realistic: a line move inside the league's
       realistic_points or a price move inside realistic_cents. Beyond that
       the card says NO REALISTIC BET TRIGGER rather than fabricate one. */
    trigger: { max_points: 6, realistic_points: { CFB: 3, NFL: 2 }, realistic_cents: 50 },
    /* BEST PLAYABLE / SAFER ALTERNATE: only a nearby line at an executable
       price can be offered beside the recommendation. An ultra-safe or
       longshot alternate never wins a generic "best" field. */
    alternates: { nearby_points: 3, min_odds: -300, max_odds: 300 },
    max_candidates_reported: 40
  };

  var MQ_ORDER = { INVALID: 0, THIN: 1, ACCEPTABLE: 2, STRONG: 3, VERIFIED: 4 };
  var CLASS_RANK = { PASS: 0, WATCH: 1, LEAN: 2, BET: 3 };
  function minClass(a, b) { return CLASS_RANK[a] <= CLASS_RANK[b] ? a : b; }

  function config(over) { return deepFreeze(merge(DEFAULT_CONFIG, over || null)); }

  /* ================================================================= WORDS
     The five decisions, as lib/edgedesk_vocab.js defines them. */
  var DECISIONS = {};
  VOC.DECISION_KEYS.forEach(function (k) { var d = VOC.DECISION[k]; DECISIONS[k] = { key: d.key, label: d.label, tone: d.tone, headline: d.headline, short: d.short, means: d.means }; });
  /* the v1 vocabulary, kept so older snapshots and tracks still read: WAIT reads WATCH */
  DECISIONS.WAIT = { key: 'WAIT', label: 'WATCH', tone: 'watch', headline: VOC.DECISION.WATCH.headline, legacy: true,
    means: 'Recorded by the v1 decision layer as WAIT (now WATCH): information required for a decision was unresolved.' };
  var MARKET_STATES = VOC.MARKET_STATE;
  var DECISION_KEYS = ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'];
  /* stake tiers (and the v1 names, read-only) */
  var STRENGTH = {
    SMALL: { key: 'SMALL', label: 'BET SMALL', rank: 1 },
    STANDARD: { key: 'STANDARD', label: 'BET', rank: 2 },
    STRONG: { key: 'STRONG', label: 'BET STRONG', rank: 3 },
    MAX: { key: 'MAX', label: 'BET MAX', rank: 4 },
    QUALIFIED: { key: 'QUALIFIED', label: 'BET SMALL', rank: 1, legacy: true },
    VERY_STRONG: { key: 'VERY_STRONG', label: 'BET STRONG', rank: 3, legacy: true }
  };
  var SOURCES = {
    calibrated: { key: 'calibrated', label: 'CALIBRATED', text: 'Probability from a live-validated calibration.' },
    partially_calibrated: { key: 'partially_calibrated', label: 'PARTIALLY CALIBRATED', text: 'Probability from an out-of-sample calibrator or a held-out-validated market blend, not yet validated on live results.' },
    model_estimated: { key: 'model_estimated', label: 'MODEL-ESTIMATED', text: 'Raw model probability: no calibration exists for this market yet (UNVALIDATED CALIBRATION). It is still judged, with lower confidence and a smaller maximum stake.' }
  };
  /* reason code → [class, sentence]. Cap codes carry the class of the cap
     that applied; blockers are NO_DECISION. */
  var REASONS = {
    QUALIFIES: ['BET', 'The current price clears EdgeDesk’s edge and expected-value thresholds with adequate market and model integrity.'],
    LEAN_EDGE: ['LEAN', 'A positive edge in the model’s direction at this price, below EdgeDesk’s betting thresholds.'],
    NEAR_THRESHOLD: ['WATCH', 'The current price is close, but it does not clear EdgeDesk’s betting threshold.'],
    MODEL_MARKET_DISAGREEMENT: ['WATCH', 'The model–market disagreement is meaningful, but the current price does not yet pay for it.'],
    PRICE_ANOMALY: ['WATCH', 'The price looks anomalous and has not passed verification. It is neither a bet nor a data failure until it does.'],
    MODEL_CONFLICT: ['WATCH', 'The model contradicts itself here: its own fair line is on the other side of this number, yet its own probability says the quote covers. The outcome distribution is off-centre at this number, so the edge is not trusted.'],
    QB_UNRESOLVED: ['WATCH', 'The starting quarterback is unresolved, and the price only qualifies if the projection survives confirmation.'],
    QB_UNKNOWN: ['WATCH', 'Quarterback status is not loaded for this game; the projection is QB-neutral until it is.'],
    AVAILABILITY_PENDING: ['WATCH', 'A material availability update is pending.'],
    THIN_MARKET: ['LEAN', 'Only one side of this number is priced: the edge is real arithmetic but the market is too thin to bet.'],
    LOW_DECISION_CONFIDENCE: ['LEAN', 'The price clears the thresholds, but decision confidence is below the betting floor.'],
    LOW_RELIABILITY: ['LEAN', 'The price clears the thresholds, but data reliability is below the betting floor.'],
    LOW_MODEL_CONFIDENCE: ['LEAN', 'The price clears the thresholds, but football confidence in this projection is below the betting floor.'],
    UNSTABLE_PROJECTION: ['LEAN', 'The price clears the thresholds, but the projection is too unstable to bet.'],
    TAIL_UNVALIDATED: ['LEAN', 'Only an alternate line outside the validated tail qualifies: the tails decide that number.'],
    BET_AUTHORITY_DISABLED: ['LEAN', 'The price clears EdgeDesk’s rules, but betting authority for this market is held by a governed policy that has not enabled betting.'],
    MARKET_NOT_VALIDATED: ['LEAN', 'This market’s probability has no validated skill yet: informational only, never a stake.'],
    SIZING_ZERO: ['LEAN', 'The price clears the thresholds, but no stake survives the sizing caps at these odds.'],
    CALIBRATED_EV_NEGATIVE: ['PASS', 'The raw model edge disappears after calibration.'],
    MARKET_ALIGNED: ['PASS', 'EdgeDesk’s fair line roughly agrees with the market: there is nothing to bet.'],
    JUICE_CONSUMES_EDGE: ['PASS', 'The number has value, but the price consumes it. A better spread does not automatically mean a good price.'],
    NO_MODEL_EDGE: ['PASS', 'The model does not favour either side at the current prices: negative expected value at every available quote.'],
    EDGE_TOO_SMALL: ['PASS', 'The edge is positive but too small to act on or to watch.'],
    PRICE_MOVED: ['PASS', 'The price moved past EdgeDesk’s playable threshold.'],
    PROJECTION_CHANGED: ['PASS', 'New information changed the projection, and the current price no longer clears the threshold.'],
    /* LAYER A blockers */
    INVALID_GAME: ['NO_DECISION', 'The game could not be identified.'],
    MAPPING_FAILED: ['NO_DECISION', 'The teams did not resolve to one scheduled event.'],
    DUPLICATE_GAME: ['NO_DECISION', 'This game maps to more than one event: the mapping must be resolved first.'],
    GAME_CANCELLED: ['NO_DECISION', 'The game was cancelled.'],
    GAME_POSTPONED: ['NO_DECISION', 'The game was postponed.'],
    GAME_SUSPENDED: ['NO_DECISION', 'The game is suspended.'],
    GAME_STARTED: ['NO_DECISION', 'The game has started: pregame decisions are closed.'],
    UNSUPPORTED_MARKET: ['NO_DECISION', 'EdgeDesk has no decision rules for this market.'],
    DATA_FAULT: ['NO_DECISION', 'An integrity check found corrupted game data: EdgeDesk’s number is unsafe until it is explained.'],
    EV_SIDE_CONTRADICTION: ['NO_DECISION', 'The EV contradicts the displayed projection: the model is past the market on one side while a quote on the other side at the same or a worse number shows positive EV. The pricing did not come from the number on screen, so nothing is decided until it does.'],
    IMPLAUSIBLE_EV: ['WATCH', 'implausible EV, check data: a main-line spread further from EdgeDesk\u2019s number than correctly-joined games reach 99.5% of the time, in widths of the game\u2019s own distribution (lib/edgedesk_quote_ev.js PLAUSIBLE_Z), is almost always a data error (a stale or mis-joined line, a flipped side), not an edge.'],
    LARGE_EV: ['WATCH', 'a main-line raw EV above 25%: plausible (inside the σ-scaled bound), and a research lead that may read VERIFIED MAJOR, but no validated record supports staking an EV that large — EdgeDesk\u2019s large disagreements have historically come with larger model error, not larger wins. Research it; no stake.'],
    MODEL_UNAVAILABLE: ['NO_DECISION', 'No EdgeDesk projection exists for this game.'],
    DISTRIBUTION_MISSING: ['NO_DECISION', 'EdgeDesk has no outcome distribution for this market, so no probability can be calculated.'],
    MODEL_VERSION_UNKNOWN: ['NO_DECISION', 'The projection carries no model version, so the price cannot be audited.'],
    MALFORMED_PROJECTION: ['NO_DECISION', 'The projection failed its distribution checks.'],
    SELF_CHECK_FAILED: ['NO_DECISION', 'The model failed its own self-check.'],
    IMPOSSIBLE_PROBABILITY: ['NO_DECISION', 'The model distribution produced impossible probabilities at the quoted lines.'],
    QB_PROJECTION_INVALID: ['NO_DECISION', 'The projection assumes a quarterback who will not start: it is invalid until re-run.'],
    NO_MARKET: ['NO_DECISION', 'No sportsbook quote is on file for this market.'],
    MARKET_SUSPENDED: ['NO_DECISION', 'The market is off the board (suspended).'],
    STALE_QUOTE: ['NO_DECISION', 'No sufficiently fresh sportsbook quote is available.'],
    FRESHNESS_UNKNOWN: ['NO_DECISION', 'No quote carries a capture time, so its freshness cannot be verified.'],
    CORRUPTED_ODDS: ['NO_DECISION', 'Every quote failed its odds or arithmetic integrity checks.'],
    NO_VALID_QUOTE: ['NO_DECISION', 'No quote on file can be priced (missing lines or quarter lines).'],
    ORIENTATION_FAULT: ['NO_DECISION', 'The home/away orientation is contradictory and could not be repaired from the team labels or the other books.']
  };
  var QUALIFIER = {
    PRICE_ANOMALY: 'PRICE ANOMALY', QB_UNRESOLVED: 'QB UNRESOLVED', QB_UNKNOWN: 'QB UNKNOWN', AVAILABILITY_PENDING: 'AVAILABILITY PENDING',
    NEAR_THRESHOLD: 'NEAR THRESHOLD', MODEL_MARKET_DISAGREEMENT: 'MODEL–MARKET DISAGREEMENT', THIN_MARKET: 'THIN MARKET',
    LOW_DECISION_CONFIDENCE: 'LOW CONFIDENCE', LOW_RELIABILITY: 'LOW RELIABILITY', LOW_MODEL_CONFIDENCE: 'LOW MODEL CONFIDENCE',
    UNSTABLE_PROJECTION: 'UNSTABLE PROJECTION', TAIL_UNVALIDATED: 'ALT TAIL', MODEL_CONFLICT: 'MODEL CONFLICT', BET_AUTHORITY_DISABLED: 'POLICY', MARKET_NOT_VALIDATED: 'INFORMATIONAL', SIZING_ZERO: 'UNSIZED',
    IMPLAUSIBLE_EV: 'IMPLAUSIBLE EV', LARGE_EV: 'LARGE EV'
  };
  /* what resolves a cap, for WATCH's "what would make it actionable" */
  var RESOLUTION = {
    PRICE_ANOMALY: 'the price passes verification', QB_UNRESOLVED: 'the starting quarterback is confirmed', QB_UNKNOWN: 'quarterback status is loaded and confirmed',
    AVAILABILITY_PENDING: 'the availability update resolves', THIN_MARKET: 'both sides are priced at this number', LOW_DECISION_CONFIDENCE: 'decision confidence reaches the betting floor',
    LOW_RELIABILITY: 'data reliability reaches the betting floor', LOW_MODEL_CONFIDENCE: 'football confidence reaches the betting floor', UNSTABLE_PROJECTION: 'the projection stabilises',
    TAIL_UNVALIDATED: 'an alternate inside the validated tail qualifies', MODEL_CONFLICT: 'the model’s probability agrees with its own fair line at this number', BET_AUTHORITY_DISABLED: 'the governed policy enables betting', MARKET_NOT_VALIDATED: 'this market’s probability is validated',
    IMPLAUSIBLE_EV: 'the data behind the implausible EV is checked and every main-line spread sits within the plausibility bound (PLAUSIBLE_Z widths of the game\u2019s distribution) of EdgeDesk\u2019s number',
    LARGE_EV: 'the main-line raw EV falls to 25% or under'
  };
  function reasonText(code) { return REASONS[code] ? REASONS[code][1] : code; }

  /* the definitions the page shows, verbatim, one home (lib/edgedesk_vocab.js) */
  var TOOLTIP = {};
  Object.keys(VOC.HELP).forEach(function (k) { TOOLTIP[k] = VOC.HELP[k]; });

  /* ====================================================== QUOTE HELPERS */
  var INTEGRITY_FLAGS = ['BREAK_EVEN_MISMATCH', 'EV_INCONSISTENT', 'EV_EDGE_SIGN', 'BOOK_MISMATCH', 'UNEXPECTED_PUSH', 'INTEGER_PUSH_MISSING', 'ORIENTATION_MISMATCH', 'EV_UNDER_NEG_50'];
  var MAGNITUDE_FLAGS = ['EV_OVER_25', 'ALT_EV_OVER_35', 'COVER_OVER_75', 'LARGE_EV_LOW_RELIABILITY', 'LARGE_EV_QB_UNRESOLVED', 'LARGE_EV_STALE_MARKET', 'LARGE_EV_MARKET_FAULT'];
  var INCONSISTENT_FLAGS = ['CONTRADICTORY_PROBABILITY', 'ARBITRAGE_CONDITION', 'BOTH_SIDES_POSITIVE', 'COVER_NON_MONOTONE', 'ALT_DISCONTINUITY'];
  function flagCodes(o) { return ((o && o.flags) || []).map(function (f) { return f.code; }); }
  function hasFlag(o, list) { var c = flagCodes(o); return c.some(function (x) { return list.indexOf(x) >= 0; }); }
  function calEv(o) { return o && o.adjusted && o.adjusted.available && isNum(o.adjusted.expected_value) ? o.adjusted.expected_value : null; }
  function calCover(o) { return o && o.adjusted && o.adjusted.available ? o.adjusted.model_cover_probability : null; }
  function homeLineOf(o) { return isNum(o.line) ? (o.side === 'home' ? o.line : -o.line) : null; }
  /* an alternate is validated only when the pricer says so: UNKNOWN (no main
     line on file for that side, so no distance to measure) is not validated */
  function tailOk(o) {
    if (!o.tail) return true;
    var st = o.tail.status;
    return st !== 'NOT_VALIDATED' && !(st === 'UNKNOWN' && !o.is_main_line);
  }
  /* a quote that passed the pricer's freshness gate, whatever vocabulary its
     source uses for it (FRESH, or EDINTEL's CURRENT / AGING) */
  function quoteFresh(o) { var st = upper(o && o.quote_status); return !!(o && o.ev_available) && st !== 'STALE' && st !== 'UNKNOWN' && st !== 'CLOCK_FAULT'; }
  /* the standard deviation of the per-unit return: the risk a plus-money
     alternate carries that EV alone hides */
  function sdOf(win, push, loss, d) {
    if (!isNum(win) || !isNum(loss) || !isNum(d)) return null;
    var mu = win * (d - 1) - loss, m2 = win * (d - 1) * (d - 1) + loss;
    var v = m2 - mu * mu;
    return v > 0 ? Math.sqrt(v) : null;
  }
  function returnSd(o) {
    var a = o && o.adjusted && o.adjusted.available ? o.adjusted : null;
    return sdOf(a ? a.model_win_probability : o.model_win_probability, a ? a.model_push_probability : o.model_push_probability, a ? a.model_loss_probability : o.model_loss_probability, o.decimal_odds);
  }
  function riskAdjusted(o) { var m = metricsOf(o); return m ? m.risk_adj : null; }
  /* how far apart the books' fresh main lines sit on one side (points) */
  function quoteDispersion(priced) {
    var out = 0;
    ['home', 'away'].forEach(function (s) {
      var ls = priced.filter(function (o) { return o.side === s && o.is_main_line && o.ev_available && isNum(o.line); }).map(function (o) { return o.line; });
      if (ls.length > 1) out = Math.max(out, Math.max.apply(null, ls) - Math.min.apply(null, ls));
    });
    return out;
  }
  function mirrorFault(priced) { return normalizeQuotes(priced.map(function (o) { return { side: o.side, line: o.line, book: o.sportsbook, captured_at: o.captured_at, market_type: o.is_main_line ? 'spread' : 'alternate_spread' }; }), {}).status === 'AMBIGUOUS'; }
  function twoSidedOf(o, priced) {
    var mirror = priced.filter(function (x) { return x.side === otherSide(o.side) && isNum(x.line) && Math.abs(x.line + o.line) < EPS && isNum(x.decimal_odds) && x.quote_status !== 'STALE' && x.ev_unavailable_code !== 'STALE'; });
    return { two_sided: mirror.length > 0, same_book: mirror.some(function (x) { return String(x.sportsbook || '').toLowerCase() === String(o.sportsbook || '').toLowerCase(); }) };
  }

  /* ============================================== ORIENTATION: ONE CANON
     Every spread quote carries its OWN side ('home'|'away') and its own line;
     its home-perspective line is line (home) or −line (away). Invariant: a
     book's two main sides are one number — CHI +1 is PHI −1. Violations are
     REPAIRED where the repair is deterministic:
       · a side read from the quote's team name (SIDE_FROM_TEAM)
       · a home-stated line turned into the side's own (LINE_FROM_HOME_LINE)
       · a book whose two sides were captured at different moments: the older
         number is superseded (SUPERSEDED_NUMBER / STALE_NUMBER_DROPPED) — the
         best-price-per-number board keeps a row per number it has seen
       · a mislabelled sign, resolved by the other books' consensus
     and dropped only when nothing can decide them (AMBIGUOUS_BOOK). The model
     never decides an orientation. */
  function sideFromTeam(q, game) {
    var t = normName(q.team || q.selection);
    if (!t || !game) return null;
    var h = normName(game.home), a = normName(game.away);
    if (h && t === h) return 'home';
    if (a && t === a) return 'away';
    return null;
  }
  function isMainSpread(q) { return (q.market_type || 'spread') === 'spread' && q.is_main_line !== false; }
  function sideKey(s) { return s == null ? '' : String(s).trim().toLowerCase(); }
  /* the market a quote belongs to: its own market_type, else an over/under
     side is a total and anything else a spread */
  function marketOf(q) { if (q.market_type) return q.market_type; var s = sideKey(q.side); return s === 'over' || s === 'under' ? 'total' : 'spread'; }
  function modeHomeLine(qs) {
    var by = {};
    qs.forEach(function (q) { var h = q.side === 'home' ? num(q.line) : -num(q.line); if (!isNum(h)) return; var k = String(r(h, 2)); by[k] = (by[k] || 0) + (num(q.n_books) || 1); });
    var ks = Object.keys(by);
    if (!ks.length) return null;
    ks.sort(function (a, b) { return (by[b] - by[a]) || (Math.abs(Number(a)) - Math.abs(Number(b))); });
    return Number(ks[0]);
  }
  function qLabel(q) { return (q.team || q.side || '?') + ' ' + lineText(num(q.line)) + (q.book ? ' @ ' + q.book : ''); }
  function normalizeQuotes(quotes, game, opts) {
    opts = opts || {};
    game = game || {};
    var out = [], repairs = [], dropped = [], relabelled = 0;
    (quotes || []).forEach(function (q0) {
      if (!q0) return;
      var q = assign({}, q0), mt = marketOf(q), sk = sideKey(q.side);
      if (mt === 'total') {
        if (sk !== 'over' && sk !== 'under') { dropped.push({ code: 'UNLABELED_SIDE', quote: qLabel(q), text: 'a total quote that is neither over nor under' }); return; }
        if (q.market_type !== 'total' || q.side !== sk) relabelled++;
        q.market_type = 'total'; q.side = sk; out.push(q); return;
      }
      var bySide = sk === 'home' || sk === 'away' ? sk : null, byTeam = sideFromTeam(q, game);
      if (bySide && byTeam && bySide !== byTeam) { dropped.push({ code: 'SIDE_TEAM_CONFLICT', quote: qLabel(q), text: 'the quote says ' + bySide + ' but its team is the ' + byTeam + ' side' }); return; }
      if (bySide && q.side !== bySide) { q.side = bySide; relabelled++; }
      if (!bySide && byTeam) { q.side = byTeam; repairs.push({ code: 'SIDE_FROM_TEAM', quote: qLabel(q), text: 'side read from the team name' }); }
      if (q.side !== 'home' && q.side !== 'away') { dropped.push({ code: 'UNLABELED_SIDE', quote: qLabel(q), text: q.side ? 'the side ' + JSON.stringify(q.side) + ' names neither team' : 'the quote names neither team' }); return; }
      if (mt === 'spread' || mt === 'alternate_spread') {
        var hl = num(q.home_line), ln = num(q.line);
        if (ln == null && hl != null) { q.line = q.side === 'home' ? hl : -hl; repairs.push({ code: 'LINE_FROM_HOME_LINE', quote: qLabel(q), text: 'home-stated line ' + lineText(hl) + ' read as ' + q.side + ' ' + lineText(q.line) }); }
        else if (ln != null && hl != null && Math.abs((q.side === 'home' ? ln : -ln) - hl) > EPS) { dropped.push({ code: 'LINE_SIGN_CONFLICT', quote: qLabel(q), text: 'the side line and the home line disagree in sign' }); return; }
      }
      out.push(q);
    });
    /* the per-book mirror of the main market */
    var books = {};
    out.forEach(function (q, i) { if (!isMainSpread(q) || !isNum(num(q.line)) || !q.book) return; var k = String(q.book).toLowerCase(); (books[k] = books[k] || { home: [], away: [] })[q.side].push(i); });
    var drop = {};
    function hlOf(i) { var q = out[i]; return q.side === 'home' ? num(q.line) : -num(q.line); }
    function tOf(i) { return ms(out[i].captured_at); }
    Object.keys(books).forEach(function (k) {
      var b = books[k];
      if (!b.home.length || !b.away.length) return;
      /* the invariant holds when the book deals one number on both sides */
      if (b.home.some(function (h) { return b.away.some(function (a) { return Math.abs(hlOf(h) - hlOf(a)) < EPS; }); })) return;
      var all = b.home.concat(b.away), tMax = null;
      all.forEach(function (i) { var t = tOf(i); if (t != null && (tMax == null || t > tMax)) tMax = t; });
      var atLatest = tMax == null ? all : all.filter(function (i) { return tOf(i) === tMax; });
      var nums = atLatest.map(hlOf).filter(function (v, j, a) { return a.indexOf(v) === j; });
      if (tMax != null && nums.length === 1) {
        /* the book moved: its latest capture is its current number, and a row
           at any other number is an older sighting it no longer deals */
        all.forEach(function (i) { if (Math.abs(hlOf(i) - nums[0]) > EPS) drop[i] = 'STALE_NUMBER_DROPPED'; });
        return;
      }
      var lh = b.home.filter(function (i) { return atLatest.indexOf(i) >= 0; })[0], la = b.away.filter(function (i) { return atLatest.indexOf(i) >= 0; })[0];
      if (lh == null) lh = b.home[0];
      if (la == null) la = b.away[0];
      /* same moment, different numbers: a flipped sign is resolved by the other books */
      var others = out.filter(function (q) { return isMainSpread(q) && String(q.book || '').toLowerCase() !== k; });
      var cons = modeHomeLine(others);
      var hh = hlOf(lh), ha = hlOf(la);
      if (cons != null && Math.abs(Math.abs(hh) - Math.abs(ha)) < EPS && Math.abs(cons - hh) < EPS) { b.away.forEach(function (i) { drop[i] = 'FLIPPED_SIGN_DROPPED'; }); return; }
      if (cons != null && Math.abs(Math.abs(hh) - Math.abs(ha)) < EPS && Math.abs(cons - ha) < EPS) { b.home.forEach(function (i) { drop[i] = 'FLIPPED_SIGN_DROPPED'; }); return; }
      b.home.concat(b.away).forEach(function (i) { drop[i] = 'AMBIGUOUS_BOOK'; });
    });
    var kept = [];
    out.forEach(function (q, i) {
      if (!drop[i]) { kept.push(q); return; }
      var code = drop[i], rec = { code: code, quote: qLabel(q), book: q.book || null };
      if (code === 'AMBIGUOUS_BOOK') { rec.text = 'this book’s two sides contradict each other at the same moment and no other book can resolve them'; dropped.push(rec); }
      else { rec.text = code === 'FLIPPED_SIGN_DROPPED' ? 'a sign that contradicts this book’s other side and every other book' : 'an older number this book no longer deals'; repairs.push(rec); }
    });
    var mainsAll = kept.filter(isMainSpread);
    var freshMains = mainsAll.filter(function (q) { return q.fresh !== false && upper(q.freshness_state) !== 'STALE'; });
    var mainsK = freshMains.length ? freshMains : mainsAll;
    var mh = modeHomeLine(mainsK.filter(function (q) { return q.side === 'home'; })), ma = modeHomeLine(mainsK.filter(function (q) { return q.side === 'away'; }));
    var ambiguous = dropped.some(function (d) { return d.code === 'AMBIGUOUS_BOOK' || d.code === 'SIDE_TEAM_CONFLICT' || d.code === 'LINE_SIGN_CONFLICT'; });
    /* a relabelled side (HOME → home) is not an orientation repair, but the
       caller's own evaluation priced the old label, so it is re-priced */
    return { quotes: kept, repairs: repairs, dropped: dropped, changed: repairs.length > 0 || dropped.length > 0 || relabelled > 0, relabelled: relabelled,
      status: ambiguous ? 'AMBIGUOUS' : (repairs.length ? 'REPAIRED' : 'OK'),
      consensus_home_line: modeHomeLine(mainsK), main_home_line_home: mh, main_home_line_away: ma,
      mirror_ok: mh == null || ma == null || Math.abs(mh - ma) <= 1 + EPS };
  }
  /* priced quotes back to raw quotes (when a caller hands only an evaluation) */
  function quotesFromEvaluation(G) {
    return allPriced(G).map(function (o) {
      var fresh = o.ev_available ? true : (o.ev_unavailable_code === 'STALE' ? false : (o.quote_status === 'FRESH' ? true : (o.quote_status === 'STALE' ? false : null)));
      return { game_id: o.game_id, side: o.side, team: o.team, line: o.line, american: o.price_source === 'AMERICAN' ? o.american_exact : null,
        decimal: o.price_source === 'AMERICAN' ? null : o.decimal_odds, book: o.sportsbook, captured_at: o.captured_at, fresh: fresh, freshness_state: o.quote_status,
        market_type: o.market_type === 'spread' && !o.is_main_line ? 'alternate_spread' : o.market_type, n_books: o.n_books_at_line, quote_id: o.quote_id,
        provider_market_key: o.provider_market_key, line_book: o.line_book, price_book: o.price_book };
    });
  }

  /* ================================================ PROBABILITY SOURCES */
  function sourceOfAdjusted(a) {
    if (!a || !a.available) return 'model_estimated';
    var m = upper(a.maturity);
    return m === 'VALIDATED' || m === 'PRODUCTION' || m === 'LIVE' || m === 'LIVE_VALIDATED' ? 'calibrated' : 'partially_calibrated';
  }
  function modelSource(model) { return sourceOfAdjusted(model && model.adjusted); }
  /* THE NFL PRICING BLEND as a probability source. The coefficients are the
     ones football/validation/pricing_nfl.json fitted on seasons BEFORE the
     season it scored (markets.spread.blend.latest_coef), the same fair line
     supabase/functions/edgedesk_ai/_pricing.js fairSpread computes (parity is
     pinned by tools/bettor/football_decision.test.js). Only the CENTRE moves:
     the shape is the league's own learned margin distribution (cover(center,
     t) = P(home margin > t)). A RESEARCH tier is not a probability source. */
  /* the same half-point bound the quote-EV side invariant applies
     (lib/edgedesk_quote_ev.js SIDE_TOLERANCE_PTS) */
  var BLEND_SIDE_TOLERANCE_PTS = 0.5;
  function blendAdjusted(opts) {
    opts = opts || {};
    var v = opts.validation || {}, c = v.blend && v.blend.latest_coef ? v.blend.latest_coef : (v.latest_coef || null);
    var tier = upper(v.tier || (opts.tier || null));
    var mm = num(opts.model_home_margin), mhl = num(opts.market_home_line);
    if (!c || typeof opts.cover !== 'function') return { available: false, reason: 'no validated pricing blend is loaded' };
    if (tier !== 'LEAN' && tier !== 'VALIDATED') return { available: false, reason: 'the pricing blend is ' + (tier || 'unrated') + ' for this market: not a probability source' };
    if (mm == null) return { available: false, reason: 'no projection to blend' };
    if (mhl == null) return { available: false, reason: 'no fresh main line to anchor the blend at' };
    var km = -mhl, fair = num(c.intercept) + num(c.close) * km + num(c.model_minus_close) * (mm - km);
    if (!isNum(fair)) return { available: false, reason: 'the blend coefficients are incomplete' };
    /* THE BLEND MAY SHRINK THE DISPLAYED DISAGREEMENT, NEVER REVERSE IT (audit
       2026-09-30 #4). The fitted blend puts 1.1565 on the market and an
       intercept of −0.38, so it extrapolates PAST the market line: PIT @ CLE,
       model CLE +0.8 against CLE +2.5, blended to PIT −2.5 — a "calibrated"
       probability centred on the other side of the line from the projection on
       screen. The calibration may pull EdgeDesk's number all the way to the
       market; it may not carry it across, because then the EV is priced from a
       projection nobody is shown. */
    var reversed = null, cov = opts.cover, Qx = Q();
    /* "not past the market against the projection" is read on the SAME
       distribution the EV is priced from: at the market line, the side the
       displayed projection favours must cover at least half the time. Where
       the blend's centre leaves it short of that (the blend crossed the line,
       or a key number at the line tips the shape), the centre is moved toward
       the displayed projection just far enough — the calibration may take
       EdgeDesk's view all the way to "no edge at the market", never past it. */
    if (Math.abs(mm - km) >= BLEND_SIDE_TOLERANCE_PTS) {
      var X = mm > km ? 'home' : 'away', lineX = X === 'home' ? mhl : -mhl;
      var coverX = function (center) { var p = Qx.sideProb(function (t) { return cov(center, t); }, X, lineX); return p && isNum(p.cover) ? p.cover : null; };
      var p0 = coverX(fair);
      if (p0 != null && p0 < 0.5 - 1e-9) {
        var lo = fair, hi = mm, pHi = coverX(hi), it;
        reversed = fair;
        if (pHi == null || pHi < 0.5 - 1e-9) fair = mm;
        else { for (it = 0; it < 48; it++) { var mid = (lo + hi) / 2, pm = coverX(mid); if (pm != null && pm < 0.5 - 1e-9) lo = mid; else hi = mid; } fair = hi; }
      }
    }
    return { available: true, label: 'BLENDED', method: 'pricing blend ' + r(num(c.intercept), 3) + ' + ' + r(num(c.close), 3) + '×market + ' + r(num(c.model_minus_close), 3) + '×(model − market)'
        + (reversed != null ? ' (held: the raw blend, ' + r(reversed, 2) + ', would have priced against the displayed projection at the market line)' : ''),
      version: opts.version || 'pricing_blend', maturity: tier === 'VALIDATED' ? 'VALIDATED' : 'SHADOW', tier: tier,
      fair_home_margin: r(fair, 4), anchor_home_line: mhl, held_at_market: reversed != null, raw_blend_home_margin: reversed != null ? r(reversed, 4) : null,
      held_reason: reversed != null ? 'the validated blend (' + r(reversed, 2) + ') left the side the displayed projection favours covering the market line less than half the time; its centre is held at ' + r(fair, 2) + ', where that side covers half the time — no edge either way, never an edge against the projection' : null,
      side_prob: function (side, line) { return Qx.sideProb(function (t) { return cov(fair, t); }, side, line); } };
  }

  /* ============================================ METRICS OF ONE QUOTE
     The decision probability is the calibrated one when the quote carries it,
     the raw model probability otherwise; both EVs are always kept. */
  function metricsOf(o) {
    if (!o || !o.ev_available) return null;
    var a = o.adjusted && o.adjusted.available ? o.adjusted : null;
    var win = a ? a.model_win_probability : o.model_win_probability, push = a ? (a.model_push_probability || 0) : (o.model_push_probability || 0);
    var loss = a ? a.model_loss_probability : o.model_loss_probability, cover = a ? a.model_cover_probability : o.model_cover_probability;
    var ev = a ? a.expected_value : o.expected_value, be = o.break_even_probability;
    if (!isNum(win) || !isNum(ev) || !isNum(be) || !isNum(cover)) return null;
    var sd = sdOf(win, push, loss, o.decimal_odds);
    var keyPp = 0;
    (o.key_numbers || []).forEach(function (k) { if (k.key === 'primary' && isNum(k.model_mass)) keyPp += 100 * k.model_mass; });
    return { o: o, source: a ? sourceOfAdjusted(a) : 'model_estimated', win: win, push: push, loss: loss, cover: cover, be: be,
      edge: cover - be, edge_pp: 100 * (cover - be), ev: ev, raw_ev: o.expected_value, calibrated_ev: a ? a.expected_value : null, raw_cover: o.model_cover_probability,
      sd: sd, risk_adj: isNum(sd) && sd > 0 ? ev / sd : null, direction_agrees: cover >= 0.5 - EPS, expected_return: 1 + ev, key_number_value_pp: r(keyPp, 3) };
  }
  function meets(m, T) { return !!m && m.edge_pp >= T.min_edge_pp - 1e-7 && m.ev >= T.min_ev - EPS; }
  function priceClass(m, cfg) {
    var T = cfg.thresholds;
    if (!m || !(m.ev > EPS)) return 'PASS';
    if (meets(m, T.bet)) return 'BET';
    if (m.edge_pp >= T.lean.min_edge_pp - 1e-7 && m.ev > T.lean.min_ev && m.direction_agrees) return 'LEAN';
    return 'WATCH';
  }
  function preferred(a, b) {
    if (!b) return true;
    if (CLASS_RANK[a.cls] !== CLASS_RANK[b.cls]) return CLASS_RANK[a.cls] > CLASS_RANK[b.cls];
    if (isNum(a.risk_adj) && isNum(b.risk_adj) && Math.abs(a.risk_adj - b.risk_adj) > 1e-6) return a.risk_adj > b.risk_adj;
    if (a.o.is_main_line !== b.o.is_main_line) return !!a.o.is_main_line;
    if (Math.abs(a.ev - b.ev) > EPS) return a.ev > b.ev;
    return a.o.line > b.o.line;
  }
  function candSummary(c) {
    var o = c.o;
    return { side: o.side, team: o.team, market_type: o.market_type === 'alternate_spread' ? 'spread' : o.market_type, is_main_line: !!o.is_main_line, line: o.line, odds: o.american_odds, decimal: r(o.decimal_odds, 4),
      book: o.sportsbook, captured_at: o.captured_at, quote_age_minutes: o.quote_age_minutes, freshness: o.quote_status || null,
      cover_probability: r(o.model_cover_probability, 4), push_probability: r(o.model_push_probability, 4), break_even_probability: r(o.break_even_probability, 4),
      decision_cover: r(c.cover, 4), edge_pp: r(c.edge_pp, 2), raw_ev: r(c.raw_ev, 4), calibrated_ev: r(c.calibrated_ev, 4), decision_ev: r(c.ev, 4),
      expected_return: r(c.expected_return, 4), risk_adjusted: r(c.risk_adj, 4), key_number_value_pp: c.key_number_value_pp, tail: o.tail ? o.tail.status : null,
      source: c.source, classification: c.cls, price_unverified: !!c.price_unverified, off_market: c.off_market || null, label: o.label || ((o.team || o.side) + ' ' + lineText(o.line) + ' (' + priceText(o.american_odds) + ')') };
  }
  function quoteSummary(o, c) {
    if (!o) return null;
    var m = c || metricsOf(o);
    return { side: o.side, team: o.team, market_type: o.market_type, is_main_line: !!o.is_main_line, line: o.line, odds: o.american_odds, decimal: o.decimal_odds,
      book: o.sportsbook, captured_at: o.captured_at, quote_age_minutes: o.quote_age_minutes, freshness: o.quote_status || null,
      quote_id: o.quote_id || null, provider_market_key: o.provider_market_key || null,
      label: o.label || ((o.team || o.side) + ' ' + lineText(o.line) + ' (' + priceText(o.american_odds) + ')'),
      cover_probability: o.model_cover_probability, push_probability: o.model_push_probability, break_even_probability: o.break_even_probability,
      raw_ev: o.expected_value, calibrated_ev: calEv(o), calibrated_cover: calCover(o), decision_cover: m ? r(m.cover, 6) : null, decision_ev: m ? r(m.ev, 6) : null,
      edge_pp: m ? r(m.edge_pp, 3) : null, fair_odds: o.model_fair_odds, risk_adjusted: m ? r(m.risk_adj, 5) : null, probability_source: m ? m.source : null,
      tail: o.tail ? o.tail.status : null, flags: flagCodes(o) };
  }

  /* ======================================================= INPUT READERS */
  function leagueOf(input) { var s = upper(input.sport || input.league || (input.model && input.model.sport) || 'CFB'); return s === 'NFL' ? 'NFL' : 'CFB'; }
  function marketKey(input, mt) { return leagueOf(input) + ':' + (mt || input.market_type || 'spread'); }
  function gameState(input) { var g = input.game || {}; return upper(g.state || g.status || null); }
  function qevCtx(input) {
    var c = copy(input.qev_ctx || {}) || {};
    c.now = input.now != null ? input.now : c.now;
    if (!c.game) c.game = input.game ? { game_id: input.game.game_id, home: input.game.home, away: input.game.away, kickoff: input.game.kickoff } : null;
    return c;
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
  function supportFor(input, side) {
    var sup = input.support || {};
    if (sup.by_side && side && isNum(num(sup.by_side[side]))) return num(sup.by_side[side]);
    return num(sup.independent_count);
  }
  function marketQuality(input, sel, priced, cfg, mk) {
    var M = input.market || {}, C = cfg.market_quality;
    if (!sel) return 'INVALID';
    if (sel.market_type === 'moneyline' || sel.market_type === 'total') {
      var mirrorML = priced.some(function (x) { return x.side !== sel.side && x.ev_available && (sel.market_type !== 'total' || Math.abs(x.line - sel.line) < EPS); });
      return mirrorML ? 'ACCEPTABLE' : 'THIN';
    }
    var ts = twoSidedOf(sel, priced);
    if (!ts.two_sided) return 'THIN';
    /* ONE book count: the canonical market's fresh books (the same quotes this
       decision priced), else the facts', else the quote's own */
    var books = mk && mk.market_depth && isNum(mk.market_depth.fresh_books) && mk.market_depth.fresh_books > 0 ? mk.market_depth.fresh_books : num(M.n_books_fresh);
    if (books == null) books = num(sel.n_books_at_line) || 1;
    var disp = num(M.dispersion);
    var dispOk = disp == null || disp <= cfg.anomaly.max_dispersion + EPS;
    var verified = M.verified !== false && (input.research || {}).verification !== 'FAILED' && (input.research || {}).verification !== 'INCOMPLETE' && !M.fault;
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

  /* ================================================ CANONICAL MATCHUP
     ONE representation, home-stated, used by every sentence below:
       fair_home_spread   = −(fair home margin)       (CHI by 2.4 → −2.4)
       market_home_spread = the consensus home line   (CHI +1 → +1.0)
       gap_toward_home    = market_home − fair_home   (> 0: value on home) */
  function canonicalOf(input, norm, sel) {
    var g = input.game || {}, M = input.market || {};
    var fm = input.model ? num(input.model.fair_home_margin) : null;
    var mh = norm && norm.consensus_home_line != null ? norm.consensus_home_line : num(M.consensus_home_line);
    var fh = fm == null ? null : r(-fm, 2);
    var gap = fh != null && mh != null ? r(mh - fh, 2) : null;
    var adjFair = input.model && input.model.adjusted && input.model.adjusted.available && isNum(num(input.model.adjusted.fair_home_margin)) ? r(-num(input.model.adjusted.fair_home_margin), 2) : null;
    var out = { away_team: g.away || null, home_team: g.home || null, fair_home_spread: fh, decision_fair_home_spread: adjFair, market_home_spread: mh,
      gap_toward_home_pts: gap, gap_pts: gap == null ? null : r(Math.abs(gap), 2), gap_toward_side: gap == null || Math.abs(gap) < EPS ? null : (gap > 0 ? 'home' : 'away'),
      gap_toward_team: gap == null || Math.abs(gap) < EPS ? null : (gap > 0 ? g.home : g.away),
      selected_side: null, selected_team: null, selected_spread: null, selected_home_spread: null, opposite: null,
      orientation: norm ? { status: norm.status, repairs: norm.repairs, dropped: norm.dropped, mirror_ok: norm.mirror_ok } : null, invariant_ok: true };
    if (sel && (sel.market_type === 'spread' || sel.market_type === 'alternate_spread')) {
      out.selected_side = sel.side; out.selected_team = sel.team || teamOf(input, sel.side); out.selected_spread = sel.line; out.selected_home_spread = homeLineOf(sel);
      out.opposite = { side: otherSide(sel.side), team: teamOf(input, otherSide(sel.side)), spread: isNum(sel.line) ? r(-sel.line, 2) : null };
      out.invariant_ok = isNum(sel.line) && Math.abs(out.selected_home_spread - (sel.side === 'home' ? out.selected_spread : -out.selected_spread)) < EPS && Math.abs(out.opposite.spread + sel.line) < EPS;
    }
    return out;
  }
  /* SAME DIRECTION: the decision model is not clearly on the other side of
     the market (its calibrated / blended fair line when it has one, the raw
     fair otherwise; inside the league's aligned band it is neutral, and the
     edge the distribution's shape gives stands). A plus-money alternate on the
     model's side agrees although its cover is under 50%; a far alternate on
     the other side does not, however cheap. */
  function directionTowardSide(canon, side) {
    if (!canon || !side || !isNum(canon.market_home_spread)) return null;
    var f = isNum(canon.decision_fair_home_spread) ? canon.decision_fair_home_spread : canon.fair_home_spread;
    if (!isNum(f)) return null;
    var g = canon.market_home_spread - f;
    return side === 'home' ? g : -g;
  }
  function gapTowardSide(canon, side) { if (!canon || !isNum(canon.gap_toward_home_pts) || !side) return null; return side === 'home' ? canon.gap_toward_home_pts : -canon.gap_toward_home_pts; }

  /* ===================================================== PRICE VERIFICATION
     A huge edge triggers a review. Checks are PASS / FAIL / UNKNOWN: a FAIL
     means the price looks broken or unverified (WATCH · PRICE ANOMALY); an
     UNKNOWN never blocks, it lowers decision confidence. A cleared review
     proceeds with a capped stake; it is never boosted. */
  function priceReview(c, ctx) {
    var input = ctx.input, cfg = ctx.cfg, L = ctx.league_cfg, A = cfg.anomaly, R = input.research || {}, M = input.market || {}, X = input.anomaly || {}, g = input.game || {};
    var o = c.o, priced = ctx.priced, G = ctx.G, canon = ctx.canon;
    var triggers = [], checks = [];
    function trig(code, text) { triggers.push({ code: code, text: text }); }
    function check(code, status, text) { checks.push({ code: code, status: status, text: text }); }
    var gap = canon && isNum(canon.gap_pts) ? canon.gap_pts : num(R.gap_pts);
    if (isNum(o.expected_value) && o.expected_value >= A.raw_ev - EPS) trig('EXTREME_RAW_EV', 'raw EV ' + pctText(o.expected_value) + ' (review at ' + pctText(A.raw_ev, 0) + ')');
    if (c.ev >= A.decision_ev - EPS && c.ev !== o.expected_value) trig('EXTREME_EV', 'decision EV ' + pctText(c.ev) + ' (review at ' + pctText(A.decision_ev, 0) + ')');
    if (c.edge_pp >= A.edge_pp - EPS) trig('EXTREME_EDGE', 'edge ' + ppText(c.edge_pp) + ' (review at ' + A.edge_pp + ' pp)');
    if (gap != null && gap >= L.major_gap_pts - EPS) trig('LARGE_GAP', 'model–market gap ' + gap.toFixed(1) + ' pts (' + ctx.league + ' review at ' + L.major_gap_pts + ')');
    if (hasFlag(o, MAGNITUDE_FLAGS)) trig('SANITY_FLAG', 'sanity guard: ' + flagCodes(o).filter(function (x) { return MAGNITUDE_FLAGS.indexOf(x) >= 0; }).join(', ').toLowerCase());
    if (X.favorite_flip) trig('FAVORITE_FLIP', 'EdgeDesk and the market favour opposite sides');
    if (upper(X.rating_divergence_band) === 'LARGE') trig('RATING_DIVERGENCE', 'large disagreement between the current rating and the production pricing state');
    var mv = num(M.movement_pts);
    if (mv != null && Math.abs(mv) >= A.move_pts - EPS) trig('ABNORMAL_MOVEMENT', 'line moved ' + Math.abs(mv).toFixed(1) + ' pts since open');
    var incG = ((G && G.flags) || []).filter(function (f) { return INCONSISTENT_FLAGS.indexOf(f.code) >= 0; });
    var incSide = incG.filter(function (f) { return ['BOTH_SIDES_POSITIVE', 'ARBITRAGE_CONDITION'].indexOf(f.code) >= 0 || String(f.text || '').indexOf(o.team || '\u0000') >= 0 || String(f.text || '').indexOf(o.label || '\u0000') >= 0; });
    if (incSide.length) trig('INCONSISTENT_QUOTES', incSide.map(function (f) { return f.code.replace(/_/g, ' ').toLowerCase(); }).join(', '));
    /* dispersion among the books ON the market: a book the canonical market
       has already named as an outlier is judged by itself (QUOTE_OUTLIER),
       never allowed to poison the books that agree */
    var outBooks = ((ctx.mcons && ctx.mcons.outliers) || []).map(function (x) { return String(x.book || '').toLowerCase(); }).filter(Boolean);
    var onMarket = outBooks.length ? priced.filter(function (x) { return outBooks.indexOf(String(x.sportsbook || '').toLowerCase()) < 0; }) : priced;
    var disp = Math.max(num(M.dispersion) || 0, quoteDispersion(onMarket));
    var dispBad = disp > A.max_dispersion + EPS;
    if (dispBad) trig('BOOK_DISPERSION', 'the books disagree by ' + disp.toFixed(1) + ' pts (limit ' + A.max_dispersion + ')' + (outBooks.length ? ' after setting aside ' + outBooks.length + ' off-market book' + (outBooks.length === 1 ? '' : 's') : ''));
    var CB = X.circuit_breaker || null;
    if (CB && CB.triggered) trig('CIRCUIT_BREAKER', 'EV circuit breaker: ' + (CB.level || 'REVIEW'));
    if (ctx.sign_suspect) trig('SIGN_SUSPECT', 'the market number only reconciles with the model once negated (' + (ctx.sign_suspect.reason || 'sign check') + ')');
    if (ctx.guard) trig('GUARD_GAP', 'the gap is past the ' + ctx.league + ' data-fault guard (' + L.guard_gap_pts + ' pts)' + (ctx.guard.reason ? ': ' + ctx.guard.reason : ''));
    var mFault = !!(M.fault || R.status === 'MARKET_FAULT' || ctx.market_check_failed);
    if (mFault) trig('MARKET_FAULT', 'market integrity: ' + (M.fault_reason || R.reason || ctx.market_check_reason || 'a book’s current numbers disagree'));
    /* ONE BOOK FAR FROM EVERY OTHER: the canonical market names it, and the
       quote (or an alternate from that book) is never promoted to BET until
       it verifies */
    var offMarket = null;
    if (ctx.mcons && MK()) {
      try { offMarket = MK().outlierText(ctx.mcons, { side: o.side, line: o.line, american: o.american_odds, book: o.sportsbook, market_type: o.is_main_line ? (o.market_type === 'total' || o.market_type === 'moneyline' ? o.market_type : 'spread') : 'alternate_spread' }, o.team || teamOf(input, o.side)); } catch (e) { offMarket = null; }
    }
    if (offMarket) trig('QUOTE_OUTLIER', offMarket);
    var unverified = R.status === 'INVESTIGATE' || R.verification === 'FAILED' || (gap != null && gap >= L.major_gap_pts && R.verification === 'INCOMPLETE');
    if (unverified) trig('UNVERIFIED_GAP', 'the gap has not passed the integrity gate' + ((R.verification_items || []).length ? ' (' + R.verification_items.slice(0, 3).join('; ') + ')' : ''));
    var out = { triggered: triggers.length > 0, severe: !!(CB && CB.level === 'SEVERE'), triggers: triggers, checks: checks, cleared: null, suspicious: false, quote: o.label || null, off_market: offMarket };
    if (!out.triggered) return out;

    check('SAME_GAME', g.game_id != null && String(o.game_id) !== String(g.game_id) ? 'FAIL' : (g.mapping_ok === false ? 'FAIL' : 'PASS'), 'the quote belongs to this game and these teams');
    check('ORIENTATION', ctx.sign_suspect || hasFlag(o, ['ORIENTATION_MISMATCH']) ? 'FAIL' : (ctx.norm && ctx.norm.status === 'AMBIGUOUS' ? 'UNKNOWN' : 'PASS'), 'home/away orientation of the quote');
    var fair = input.model ? num(input.model.fair_home_margin) : null, mh = canon ? canon.market_home_spread : null, SF = L.sign_flip;
    var signFlip = fair != null && mh != null && Math.abs(fair + mh) > SF.bound && Math.abs(fair - mh) <= SF.reconcile;
    check('SPREAD_SIGN', fair == null || mh == null ? 'UNKNOWN' : (signFlip ? 'FAIL' : 'PASS'), 'a gap that vanishes when the market sign is flipped is a sign fault');
    check('FRESH_QUOTE', !quoteFresh(o) ? 'FAIL' : (isNum(o.quote_age_minutes) && o.quote_age_minutes > cfg.freshness.max_quote_age_minutes ? 'UNKNOWN' : 'PASS'), 'the evaluated quote is inside the freshness limit' + (isNum(o.quote_age_minutes) ? ' (' + Math.round(o.quote_age_minutes) + ' min old)' : ''));
    if (o.is_main_line && o.market_type !== 'moneyline' && o.market_type !== 'total') {
      var dev = mh != null ? Math.abs(homeLineOf(o) - mh) : null;
      check('CONSENSUS_AGREEMENT', dev == null ? 'UNKNOWN' : (dev <= L.consensus_tolerance_pts + EPS ? 'PASS' : 'FAIL'), 'the quote sits within ' + L.consensus_tolerance_pts + ' pts of the consensus' + (dev != null ? ' (' + dev.toFixed(1) + ' away)' : ''));
    }
    var ladFlags = ((G && G.sides && G.sides[o.side] && G.sides[o.side].ladder && G.sides[o.side].ladder.flags) || []);
    var nonMono = ladFlags.some(function (f) { return f.code === 'COVER_NON_MONOTONE' || f.code === 'CONTRADICTORY_PROBABILITY'; });
    /* impossible monotonicity at one book: more points must never pay a better price */
    var bookSide = priced.filter(function (x) { return x.ev_available && x.side === o.side && String(x.sportsbook || '').toLowerCase() === String(o.sportsbook || '').toLowerCase() && isNum(x.line) && isNum(x.decimal_odds); });
    var priceMono = bookSide.some(function (x) { return bookSide.some(function (y) { return y.line > x.line + EPS && y.decimal_odds > x.decimal_odds + 0.02; }); });
    check('LADDER_CONSISTENT', nonMono || priceMono ? 'FAIL' : 'PASS', priceMono ? 'a book prices more points at a better price (impossible ladder)' : 'the alternate ladder is monotone');
    if (!o.is_main_line) {
      var disc = ladFlags.some(function (f) { return (f.code === 'ALT_DISCONTINUITY' || f.code === 'ALT_IMPLAUSIBLE') && String(f.text || '').indexOf(lineText(o.line)) >= 0; });
      check('NEIGHBOR_PRICES', disc ? 'FAIL' : 'PASS', 'neighbouring alternate prices are continuous with this one');
    }
    var sameSide = priced.filter(function (x) { return x.ev_available && x.side === o.side && x.market_type === o.market_type && String(x.sportsbook || '').toLowerCase() !== String(o.sportsbook || '').toLowerCase(); });
    var corroborated = (num(o.n_books_at_line) || 1) >= 2 || sameSide.some(function (x) { return Math.abs(x.line - o.line) <= 0.5 + EPS; });
    check('BOOK_CORROBORATION', corroborated ? 'PASS' : (sameSide.length ? 'FAIL' : 'UNKNOWN'), corroborated ? 'another book deals this side within half a point' : (sameSide.length ? 'every other book deals this side more than half a point away' : 'only one book prices this side: nothing to compare with'));
    check('BOOK_AGREEMENT', dispBad ? 'FAIL' : 'PASS', 'the books agree within ' + A.max_dispersion + ' pts');
    check('NO_ARBITRAGE', incG.some(function (f) { return f.code === 'BOTH_SIDES_POSITIVE' || f.code === 'ARBITRAGE_CONDITION'; }) ? 'FAIL' : 'PASS', 'both sides of one number cannot both be good bets');
    check('MARKET_INTEGRITY', mFault ? 'FAIL' : 'PASS', 'no market integrity fault');
    check('BOOK_ON_MARKET', offMarket ? 'FAIL' : 'PASS', offMarket || 'this book’s number sits with the rest of the market');
    check('GAP_VERIFIED', unverified ? 'FAIL' : 'PASS', 'a large gap has passed the research integrity gate (or none was required)');
    check('GAP_PLAUSIBLE', ctx.guard || (gap != null && gap > L.guard_gap_pts) ? 'FAIL' : (gap != null && gap > L.outlier_gap_pts ? 'UNKNOWN' : 'PASS'), 'model–market gap inside the ' + ctx.league + ' outlier band (' + L.outlier_gap_pts + ' pts)');
    if (CB && CB.triggered) check('CIRCUIT_BREAKER_VERIFIED', CB.verified === true ? 'PASS' : 'FAIL', 'the EV engine’s extreme-edge checks');
    out.suspicious = checks.some(function (x) { return x.status === 'FAIL'; });
    out.cleared = !out.suspicious;
    return out;
  }

  /* ================================================= DECISION CONFIDENCE
     0-100: can the decision itself be trusted? Never a win probability. */
  function decisionConfidence(input, c, mq, stab, review, source, cfg, extra) {
    var W = cfg.confidence.weights, comp = {}, notes = [];
    extra = extra || {};
    var cf = input.confidence ? num(input.confidence.score) : null;
    comp.model = cf == null ? 0.5 : clamp(cf / 100, 0, 1);
    if (cf == null) notes.push('model confidence unmeasured');
    var rel = input.reliability ? num(input.reliability.score) : null;
    comp.reliability = rel == null ? 0.45 : clamp(rel / 100, 0, 1);
    if (rel == null) notes.push('reliability unmeasured');
    comp.stability = { HIGH: 1, MEDIUM: 0.7, UNMEASURED: 0.5, LOW: 0.2 }[stab] || 0.5;
    var age = c && c.o ? num(c.o.quote_age_minutes) : null;
    comp.freshness = age == null ? 0.5 : clamp(1 - 0.6 * age / cfg.freshness.reference_minutes, 0.4, 1);
    comp.market = { VERIFIED: 1, STRONG: 0.85, ACCEPTABLE: 0.65, THIN: 0.35, INVALID: 0 }[mq] || 0;
    var qb = input.qb || {};
    comp.qb = qb.unresolved_critical ? 0.3 : (qb.known === false ? 0.45 : (qb.contested ? 0.55 : (qb.unconfirmed ? 0.8 : 1)));
    var av = input.availability || {};
    comp.availability = av.major_uncertainty || av.pending ? 0.3 : (av.uncertain ? 0.7 : (av.known === false ? 0.6 : 1));
    comp.calibration = { calibrated: 1, partially_calibrated: 0.7, model_estimated: 0.4 }[source] || 0.4;
    comp.consistency = extra.inconsistent ? 0.4 : 1;
    comp.anomaly = !review || !review.triggered ? 1 : (review.suspicious ? 0.3 : 0.75);
    if (review && review.triggered && review.checks) {
      var unk = review.checks.filter(function (x) { return x.status === 'UNKNOWN'; }).length;
      if (unk) { comp.anomaly = Math.max(0.2, comp.anomaly - 0.1 * unk); notes.push(unk + ' unverifiable check' + (unk === 1 ? '' : 's')); }
    }
    var total = 0, k;
    for (k in W) if (has(W, k)) total += W[k] * (isNum(comp[k]) ? comp[k] : 0);
    var score = Math.round(100 * total);
    var label = 'Very low';
    for (var i = 0; i < cfg.confidence.labels.length; i++) if (score >= cfg.confidence.labels[i][0]) { label = cfg.confidence.labels[i][1]; break; }
    Object.keys(comp).forEach(function (x) { comp[x] = r(comp[x], 3); });
    return { score: score, label: label, components: comp, weights: copy(W), notes: notes };
  }

  /* ============================================================ SIZING
     Units = the highest tier the edge, EV and decision confidence support,
     then the MINIMUM of every cap (probability source, market quality,
     anomaly, material warnings, quarter-Kelly), rounded DOWN onto the grid.
     Raw EV never enters it; neither does any past result. */
  function floorGrid(u, grid) { var out = 0; grid.forEach(function (g) { if (u >= g - EPS) out = g; }); return out; }
  function sizing(input, c, ctx) {
    var cfg = ctx.cfg, S = cfg.sizing, conf = ctx.confidence, review = ctx.review, L = ctx.league_cfg;
    var gapSide = gapTowardSide(ctx.canon, c.o.side);
    var material = (ctx.warnings || []).filter(function (w) { return S.material_warnings.indexOf(w.code) >= 0; });
    var qb = input.qb || {}, av = input.availability || {};
    var trail = [], signal = 0, signalTier = null;
    S.tiers.forEach(function (t) {
      var why = [];
      if (!(c.edge_pp >= t.min_edge_pp - 1e-7)) why.push('edge ' + ppText(c.edge_pp) + ' below ' + t.min_edge_pp + ' pp');
      if (!(c.ev >= t.min_ev - EPS)) why.push('EV ' + pctText(c.ev) + ' below ' + pctText(t.min_ev, 0));
      if (!(conf.score >= t.min_confidence)) why.push('decision confidence ' + conf.score + ' below ' + t.min_confidence);
      if (t.require_gap && !(isNum(gapSide) && gapSide >= L.strong_gap_pts - EPS)) why.push('model–market disagreement toward this side under ' + L.strong_gap_pts + ' pts');
      if (t.require_source && c.source !== t.require_source) why.push('probability is ' + SOURCES[c.source].label + ', not ' + SOURCES[t.require_source].label);
      if (t.require_clean && (material.length || (review && review.triggered) || qb.unresolved_critical || qb.known === false || qb.unconfirmed || av.uncertain || av.pending || av.major_uncertainty)) why.push('an uncertainty flag is open');
      if (t.min_market_quality && (MQ_ORDER[ctx.mq] || 0) < MQ_ORDER[t.min_market_quality]) why.push('market quality below ' + t.min_market_quality);
      trail.push({ key: t.key, units: t.units, allowed: !why.length, why: why });
      if (!why.length) { signal = t.units; signalTier = t.key; }
    });
    var caps = [], units = signal;
    function cap(v, text) { if (units > v + EPS) { caps.push(text); units = v; } }
    cap(S.source_caps[c.source] != null ? S.source_caps[c.source] : 0.25, SOURCES[c.source].label + ' probability cap ' + unitsText(S.source_caps[c.source]));
    if (S.market_caps[ctx.mq] != null) cap(S.market_caps[ctx.mq], ctx.mq + ' market cap ' + unitsText(S.market_caps[ctx.mq]));
    if (review && review.triggered && review.cleared) cap(cfg.anomaly.cleared_unit_cap, 'cleared-anomaly cap ' + unitsText(cfg.anomaly.cleared_unit_cap));
    if (review && review.severe) cap(cfg.anomaly.severe_unit_cap, 'severe-extreme cap ' + unitsText(cfg.anomaly.severe_unit_cap));
    if (material.length) cap(S.material_cap, 'material warning cap ' + unitsText(S.material_cap) + ' (' + material.map(function (w) { return w.code; }).join(', ') + ')');
    var b = isNum(c.o.decimal_odds) ? c.o.decimal_odds - 1 : null;
    var kellyUnits = b && b > 0 && c.ev > 0 ? S.kelly_fraction * (c.ev / b) / S.unit_pct_of_bankroll : null;
    if (kellyUnits != null) cap(floorGrid(kellyUnits, S.grid), 'quarter-Kelly ceiling ' + unitsText(r(kellyUnits, 2)) + ' at ' + priceText(c.o.american_odds));
    cap(S.max_units, 'maximum ' + unitsText(S.max_units));
    units = floorGrid(units, S.grid);
    var tierOf = S.tiers.filter(function (t) { return Math.abs(t.units - units) < EPS; })[0];
    return { units: units, shadow_units: signal, tier: tierOf ? tierOf.key : null, signal_tier: signalTier, kelly_units: r(kellyUnits, 3), tiers: trail, caps: caps,
      material_warnings: material.map(function (w) { return w.code; }), validation: UNVALIDATED };
  }

  /* ======================================================== PRICE SEARCH
     A hypothetical quote priced by EDQuoteEV on the same model: the search
     never invents a probability, it moves only the line and the price. */
  function hypoQuote(input, sel, line, american) {
    var main = !!sel.is_main_line;
    var q = { game_id: input.game ? input.game.game_id : null, side: sel.side, team: sel.team, line: line, american: american, book: sel.sportsbook,
      captured_at: iso(input.now), fresh: true, market_type: sel.market_type === 'moneyline' || sel.market_type === 'total' ? sel.market_type : (main ? 'spread' : 'alternate_spread'), n_books: 1 };
    var c = input._qctx ? assign({}, input._qctx) : qevCtx(input);
    var G = input._evaluation;
    /* a main-line hypothetical IS the new main line; an alternate keeps its distance */
    c.main_line_for_side = main ? line : (G && G.main_line ? G.main_line[sel.side] : sel.line);
    return Q().priceQuote(input.model, q, c);
  }
  function clearsAt(input, sel, line, american, cfg) {
    var o = hypoQuote(input, sel, line, american);
    if (!o || !o.ev_available || !tailOk(o) || hasFlag(o, INTEGRITY_FLAGS)) return false;
    return meets(metricsOf(o), cfg.thresholds.bet);
  }
  function worstPrice(input, sel, line, cfg) {
    var Qx = Q(), hi = Qx.americanToDecimal(cfg.playable.odds_ceiling), lo, i;
    if (!clearsAt(input, sel, line, cfg.playable.odds_ceiling, cfg)) return null;
    if (clearsAt(input, sel, line, cfg.playable.odds_floor, cfg)) return { odds: cfg.playable.odds_floor, floored: true };
    lo = Qx.americanToDecimal(cfg.playable.odds_floor);
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
  /* PLAYABLE TO (BET): the corner (worst line, worst price there) clears */
  function playable(input, sel, cfg) {
    if (!sel || sel.market_type === 'moneyline' || sel.market_type === 'total') return null;
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
    var team = sel.team || sel.side, text;
    if (only) text = 'CURRENT PRICE ONLY';
    else if (Math.abs(corner.line - L0) < EPS) text = team + ' ' + lineText(L0) + ' or better · maximum ' + priceText(corner.max_odds);
    else text = team + ' ' + lineText(L0) + ' to ' + lineText(corner.line) + ' · up to ' + priceText(corner.max_odds);
    return { mode: only ? 'CURRENT_PRICE_ONLY' : 'RANGE', min_line: corner ? corner.line : L0, max_odds: corner ? corner.max_odds : P0,
      at_current_line_max_odds: atCur ? atCur.max_odds : P0, frontier: frontier, text: text,
      short: only ? 'CURRENT PRICE ONLY' : lineText(corner.line) + ' / ' + priceText(corner.max_odds),
      thresholds: copy(cfg.thresholds.bet),
      basis: 'The worst quote at which the edge still clears ' + cfg.thresholds.bet.min_edge_pp + ' pp and the EV ' + pctText(cfg.thresholds.bet.min_ev, 0) + ', holding the rest of the market where it is. If the consensus itself moves, EdgeDesk re-prices every number.' };
  }
  /* BET TRIGGER (LEAN / WATCH / PASS): what this side would need.
     Every option the search finds is kept (options[], for the audit); only a
     REALISTIC one — a line move inside the league's realistic_points, a price
     move inside realistic_cents — is named to the reader (short, text). With
     none, the trigger says so instead of fabricating one. */
  function realisticBounds(input, cfg) {
    var T = cfg.trigger || {}, lg = leagueOf(input);
    var rp = T.realistic_points == null ? T.max_points : (isNum(T.realistic_points) ? T.realistic_points : (isNum(T.realistic_points[lg]) ? T.realistic_points[lg] : T.realistic_points.CFB));
    return { points: isNum(rp) ? rp : T.max_points, cents: isNum(T.realistic_cents) ? T.realistic_cents : Infinity };
  }
  function betTrigger(input, ref, cfg) {
    if (!ref || !isNum(ref.american_odds)) return null;
    var spread = ref.market_type !== 'moneyline' && ref.market_type !== 'total';
    var team = ref.team || ref.side;
    /* the price already clears: what holds it back is not the price, so
       there is no price to wait for */
    if (clearsAt(input, ref, ref.line, ref.american_odds, cfg)) {
      return { already_clears: true, realistic: true, options: [], line_needed: null, price_needed_at_current_line: ref.american_odds, line_move_pts: null, price_move_cents: null, short: null,
        text: 'The price already clears the betting thresholds at ' + pickText(ref, team, ref.line) + ' (' + priceText(ref.american_odds) + '); what holds it back is not the price.',
        caveat: null };
    }
    var needLine = null, k;
    if (spread && isNum(ref.line)) {
      for (k = 1; k <= Math.round(cfg.trigger.max_points * 2); k++) {
        var cand = ref.line + k * 0.5;
        if (clearsAt(input, ref, cand, ref.american_odds, cfg)) { needLine = r(cand, 2); break; }
      }
    }
    var wp = worstPrice(input, ref, ref.line, cfg);
    var Qx = Q(), RB = realisticBounds(input, cfg);
    var at = function (line, odds) { return pickText(ref, team, line) + ' (' + priceText(odds) + ')'; };
    var options = [];
    if (needLine != null) { var mv = r(needLine - ref.line, 2); options.push({ kind: 'line', line: needLine, odds: ref.american_odds, move_pts: mv, realistic: mv <= RB.points + EPS, text: at(needLine, ref.american_odds) }); }
    if (wp && !wp.floored) { var ct = r(Qx.centsBetter(ref.american_odds, wp.odds), 1); options.push({ kind: 'price', line: ref.line, odds: wp.odds, move_cents: ct, realistic: isNum(ct) && ct <= RB.cents + EPS, text: at(ref.line, wp.odds) }); }
    var real = options.filter(function (o) { return o.realistic; });
    var who = ref.market_type === 'total' ? 'The ' + String(ref.side || 'total').toLowerCase() : team;
    return { already_clears: false, realistic: real.length > 0, options: options,
      line_needed: needLine, price_needed_at_current_line: wp ? wp.odds : null,
      line_move_pts: needLine != null ? r(needLine - ref.line, 2) : null,
      price_move_cents: wp && !wp.floored ? r(Qx.centsBetter(ref.american_odds, wp.odds), 1) : null,
      realistic_bounds: { points: RB.points, cents: RB.cents },
      short: real.length ? real.map(function (o) { return o.text; }).join(' or ') + ' or better' : null,
      text: real.length ? who + ' becomes BET at ' + real.map(function (o) { return o.text; }).join(' or ') + ' or better, if the rest of the market stays where it is.'
        : VOC.COPY.no_realistic_trigger + '.',
      detail: real.length ? null : (options.length ? 'The nearest quote that would clear is ' + options.map(function (o) { return o.text + (o.kind === 'line' ? ' (' + o.move_pts + ' pts away)' : ' (' + o.move_cents + '¢ away)'); }).join(' or ') + ': beyond a realistic move (' + RB.points + ' pts or ' + RB.cents + '¢).'
        : 'No line within ' + cfg.trigger.max_points + ' points and no price at this line would clear the betting thresholds.'),
      caveat: real.length ? 'If the whole market moves to that number, the calibrated probability moves with it; EdgeDesk re-evaluates automatically.' : null };
  }
  function nearTrigger(tr, L) {
    if (!tr || !L) return false;
    return (isNum(tr.line_move_pts) && tr.line_move_pts <= L.watch_trigger_points + EPS) || (isNum(tr.price_move_cents) && tr.price_move_cents <= L.watch_trigger_cents + EPS);
  }

  /* ================================================ CANONICAL MARKET
     ONE market object per decision (lib/edgedesk_market.js), built from the
     same normalised quotes the decision priced, around the exact quote the
     decision reads. Every surface prints this object's line, consensus and
     verification; none recomputes them. */
  function marketCanon(input, quotes, selQ, mt, league, norm, fair) {
    var M = MK();
    if (!M) return null;
    try {
      var sq = selQ ? { side: selQ.side, team: selQ.team, line: selQ.line, american: selQ.american_odds, book: selQ.sportsbook, captured_at: selQ.captured_at,
        market_type: mt === 'spread' && selQ.is_main_line === false ? 'alternate_spread' : mt,
        fresh: quoteFresh(selQ) ? true : (upper(selQ.quote_status) === 'STALE' || selQ.ev_unavailable_code === 'STALE' ? false : null) } : null;
      return M.canonical({ event_id: (input.game || {}).game_id, sport: league, market_type: mt, quotes: quotes || [], selected: sq,
        team: selQ ? (selQ.team || teamOf(input, selQ.side)) : null, now: input.now,
        orientation: norm ? { status: norm.status, repairs: norm.repairs, dropped: norm.dropped } : null,
        source: (input.market && input.market.source) || input.market_source || null, fair: fair, evaluated_at: input.now,
        history: input.market_history || null, keys: input.key_numbers || null, external_fresh_books: input.market ? num(input.market.n_books_fresh) : null });
    } catch (e) { return { schema: 'edgedesk_canonical_market_v1', error: String(e && e.message || e).slice(0, 160) }; }
  }
  function marketConsensus(quotes, mt, league, now) {
    var M = MK();
    if (!M) return null;
    try { return M.consensus(quotes || [], { market_type: mt, sport: league, now: now }); } catch (e) { return null; }
  }

  /* ===================================================== EXECUTION LAYER
     A hypothetical quote classified by EXACTLY the rules the decision used:
     the price class, the tail rule, every non-price cap the decision carries,
     sizing, and the WATCH-for-price rule (the BET threshold within the
     league's watch window, or a sub-threshold edge on a meaningful
     disagreement). lib/edgedesk_execution.js turns these into the price
     curve, the ladder of transition points and the best execution. */
  function hypoClassifier(input, sel, x) {
    var cfg = x.cfg, L = x.L, mt = sel.o.market_type, isSpread = mt !== 'moneyline' && mt !== 'total', XE = EX();
    return function (line, am) {
      var ln = line == null ? sel.o.line : line;
      var o = hypoQuote(input, sel.o, ln, am);
      if (!o || !o.ev_available || hasFlag(o, INTEGRITY_FLAGS)) return null;
      var m = metricsOf(o);
      if (!m) return null;
      if (x.source) m.source = x.source;
      if (mt === 'moneyline') m.direction_agrees = m.edge > EPS;
      else if (isSpread) { var dir = directionTowardSide(x.canon, sel.o.side); if (isNum(dir)) m.direction_agrees = dir >= -(L.aligned_gap_pts || 0) - EPS; }
      var pc = priceClass(m, cfg), cls = pc, capped = null;
      if (!tailOk(o) && CLASS_RANK[cls] > CLASS_RANK.LEAN) { cls = 'LEAN'; capped = 'TAIL_UNVALIDATED'; }
      /* line-specific caps are recomputed at THIS line; every other cap the decision carries applies as it is */
      (x.caps || []).forEach(function (c) { if (c.code === 'SIZING_ZERO' || c.code === 'TAIL_UNVALIDATED' || c.code === 'MODEL_CONFLICT') return; if (CLASS_RANK[c.max] < CLASS_RANK[cls]) { cls = c.max; capped = c.code; } });
      if (isSpread && isNum(x.fairSide) && isNum(ln) && ln - x.fairSide < -((L.aligned_gap_pts || 0) + EPS) && isNum(m.raw_cover) && m.raw_cover > 0.5 + EPS && m.cover > 0.5 + EPS && CLASS_RANK[pc] >= CLASS_RANK.LEAN && CLASS_RANK.WATCH < CLASS_RANK[cls]) { cls = 'WATCH'; capped = 'MODEL_CONFLICT'; }
      var units = 0;
      if (cls === 'BET') {
        var Z = sizing(input, m, { cfg: cfg, confidence: x.conf, review: x.review, mq: x.mq, canon: x.canon, league_cfg: L, warnings: x.warnings });
        units = Z.units;
        if (!(units > 0)) { cls = 'LEAN'; capped = 'SIZING_ZERO'; }
      } else if (cls !== 'LEAN' && !capped) {
        var near = (isSpread && isNum(ln) && clearsAt(input, sel.o, r(ln + L.watch_trigger_points, 2), am, cfg))
          || (XE && clearsAt(input, sel.o, ln, XE.stepPrice(am, L.watch_trigger_cents), cfg));
        if (near) cls = 'WATCH';
        /* the engine's own rule for a sub-threshold disagreement: WATCH only
           when a realistic price can turn it into a BET (betTrigger realistic
           and short) — without that the ladder said WATCH where the decision
           said PASS, e.g. an alternate whose every BET number is outside the
           validated tail */
        else if (pc === 'WATCH' && isSpread && isNum(x.gSide) && x.gSide >= L.watch_gap_pts - EPS) {
          var tr = null; try { tr = betTrigger(input, o, cfg); } catch (e) { tr = null; }
          cls = tr && tr.realistic && tr.short ? 'WATCH' : 'PASS';
        }
        else cls = 'PASS';
      }
      return { cls: cls, units: units, cover: m.cover, break_even: m.be, edge_pp: m.edge_pp, ev: m.ev, raw_ev: m.raw_ev, calibrated_ev: m.calibrated_ev, source: m.source, capped_by: capped };
    };
  }
  function attachExecution(out, input, sel, x, finalCls) {
    var XE = EX();
    if (!XE || !sel || !sel.o) return;
    var mt = sel.o.market_type === 'alternate_spread' ? 'spread' : (sel.o.market_type || 'spread');
    var pushMass = mt === 'spread' && input.model && typeof input.model.home_cover === 'function'
      ? function (side, k) { try { var p = Q().sideProb(input.model.home_cover, side, k); return p && !p.fault ? p.push : null; } catch (e) { return null; } } : null;
    try {
      var classify = hypoClassifier(input, sel, x);
      var C = XE.curve(classify, sel.o);
      if (C) {
        /* the current point IS the decision: its classification is checked
           against the engine's, then the engine's answer is what is printed */
        var self = null, decided = XE.stateOf({ cls: finalCls, units: out.recommended_units });
        C.points.forEach(function (p) { if (p.current) { self = { classified: XE.stateOf(p), decided: decided, agrees: XE.stateOf(p) === decided }; p.cls = finalCls; p.units = finalCls === 'BET' ? out.recommended_units : 0; } });
        C.self_check = self;
        out.price_curve = C;
        out.ladder = XE.ladder(classify, sel.o, { curve: C, pushMass: pushMass });
      }
    } catch (e) { out.ladder = { error: String(e && e.message || e).slice(0, 160) }; }
    try {
      out.best_execution = XE.bestExecution(out.candidates, { side: sel.o.side, market_type: mt, market: out.market, max_age_minutes: x.cfg.freshness.max_quote_age_minutes,
        pushMass: pushMass, selected: { book: sel.o.sportsbook, line: sel.o.line, odds: sel.o.american_odds } });
      if (out.market && out.best_execution && out.best_execution.best) {
        var b = out.best_execution.best;
        out.market.best_execution_price = { label: b.label, line: b.line, odds: b.odds, book: b.book, decision_ev: b.decision_ev, calibrated_ev: b.calibrated_ev };
      }
    } catch (e) { out.best_execution = { error: String(e && e.message || e).slice(0, 160) }; }
  }

  /* ============================================================ VERSIONS
     Every decision knows what produced it and the newest input it read, so
     a historical decision stays attached to the versions that made it and an
     input from after the evaluation is caught (leakage_ok). */
  function versionsOf(input, d) {
    var qs = input.quotes || (input.evaluation && input.evaluation.sides ? quotesFromEvaluation(input.evaluation) : []);
    var ts = (qs || []).map(function (q) { return q ? ms(q.captured_at) : null; }).filter(isNum);
    var now = ms(input.now), ko = ms((input.game || {}).kickoff);
    var qLatest = ts.length ? Math.max.apply(null, ts) : null, qOldest = ts.length ? Math.min.apply(null, ts) : null;
    var proj = input.model ? ms(input.model.projection_timestamp || input.model.built_at) : null, facts = ms(input.facts_as_of);
    var parts = [qLatest, proj, facts].filter(isNum), snap = parts.length ? Math.max.apply(null, parts) : null;
    var future = ts.filter(function (t) { return now != null && t > now + 5 * 60e3; }).length;
    var v = { model: d.model_version, calibration: d.calibration_version, pricing_engine: d.pricing_model_version, decision_engine: d.decision_engine_version,
      decision_rules: d.config_version, market_engine: MK() ? MK().VERSION : null, execution_engine: EX() ? EX().VERSION : null,
      quotes_latest_at: iso(qLatest), quotes_oldest_at: iso(qOldest), model_projection_at: iso(proj), facts_as_of: iso(facts), data_snapshot_at: iso(snap),
      evaluated_at: d.evaluated_at, kickoff: d.kickoff, pregame: now == null || ko == null ? null : now < ko,
      inputs_after_evaluation: future, leakage_ok: future === 0 && (proj == null || now == null || proj <= now + 5 * 60e3) };
    v.version_key = 'dv_' + hash([v.model, v.calibration, v.pricing_engine, v.decision_engine, v.decision_rules, v.market_engine, v.execution_engine]);
    return v;
  }

  /* ========================================================== WARNINGS */
  function warningsOf(input, c, ctx) {
    var w = [], qb = input.qb || {}, av = input.availability || {}, X = input.anomaly || {}, g = input.game || {}, cfg = ctx.cfg, S = cfg.sizing;
    function add(code, text) { if (!w.some(function (x) { return x.code === code; })) w.push({ code: code, text: text }); }
    add('RULES_UNVALIDATED', 'Decision thresholds and stake tiers are conservative defaults, not yet validated on live results; the live record and CLV sample are still accumulating. Research, never a guarantee.');
    var src = c ? c.source : ctx.source;
    if (src === 'model_estimated') add('CALIBRATION_UNVALIDATED', 'MODEL-ESTIMATED: no calibration exists for this market, so the raw model probability is used and the stake is capped at ' + unitsText(S.source_caps.model_estimated) + '.');
    if (src === 'partially_calibrated') {
      var a = input.model && input.model.adjusted;
      add('CALIBRATION_PARTIAL', 'PARTIALLY CALIBRATED: ' + (a && a.method ? a.method : 'the calibration') + (a && a.maturity ? ' (' + upper(a.maturity) + ')' : '') + ' is validated out of sample, not on live results; the stake is capped at ' + unitsText(S.source_caps.partially_calibrated) + '.');
    }
    if (input.reliability == null || num((input.reliability || {}).score) == null) add('RELIABILITY_UNMEASURED', 'Data reliability is not measured for this game: decision confidence is reduced.');
    if (input.confidence == null || num((input.confidence || {}).score) == null) add('MODEL_CONFIDENCE_UNMEASURED', 'Football confidence is not measured for this projection: decision confidence is reduced.');
    if (qb.unconfirmed && !qb.unresolved_critical) add('QB_UNCONFIRMED', 'A starting quarterback is expected but not confirmed.');
    if (qb.contested) add('QB_CONTESTED', 'A quarterback situation is contested.');
    if (av.known === false) add('PERSONNEL_LOW_CONFIDENCE', 'Availability/personnel data is not loaded for this game: the base model is used and confidence is reduced.');
    else if (av.uncertain && !av.major_uncertainty) add('AVAILABILITY_UNCERTAIN', 'Availability data is incomplete.');
    if (ctx.mq === 'ACCEPTABLE') add('SINGLE_BOOK', 'Only one fresh book prices both sides of this number.');
    else if (ctx.mq === 'THIN') add('SINGLE_BOOK', 'Only one side of this number is priced.');
    if (ctx.stab === 'UNMEASURED') add('STABILITY_UNMEASURED', 'Projection stability was not measured.');
    if (upper(X.rating_divergence_band) === 'LARGE') add('LARGE_RATING_DIVERGENCE', 'The current rating and the pricing state disagree about this matchup.');
    if (X.fcs || g.fcs) add('FCS_GAME', 'An FCS team is involved.');
    var gap = ctx.canon ? ctx.canon.gap_pts : null;
    if (isNum(gap) && gap > ctx.league_cfg.outlier_gap_pts) add('MODEL_MARKET_OUTLIER', 'The model disagrees with the market by ' + gap.toFixed(1) + ' pts, beyond the ' + ctx.league + ' outlier band (' + ctx.league_cfg.outlier_gap_pts + '): more likely a model miss than a market miss.');
    if (ctx.review && ctx.review.triggered && ctx.review.cleared) add('ANOMALY_CLEARED', 'The edge triggered price verification; every check cleared, and the stake is capped.');
    if (ctx.norm && ctx.norm.repairs && ctx.norm.repairs.some(function (x) { return x.code === 'FLIPPED_SIGN_DROPPED'; })) add('ORIENTATION_REPAIRED', 'A book’s mislabelled sign was repaired from the other books before pricing.');
    if (c && !c.o.is_main_line && c.o.market_type !== 'moneyline' && c.o.market_type !== 'total') add(c.o.tail && c.o.tail.status === 'VALIDATED' ? 'ALT_LINE' : 'ALT_LINE_TAIL', 'The selected quote is an alternate line.');
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

  /* ============================================================ OUTPUT */
  function skeleton(input, cfg, mt) {
    var g = input.game || {}, M = input.market || {}, R = input.research || {}, Rl = input.reliability || {}, Cf = input.confidence || {}, P = input.projection || {};
    var fm = input.model ? num(input.model.fair_home_margin) : null, ch = num(M.consensus_home_line);
    return {
      schema: VERSION, decision_engine_version: VERSION, config_version: cfg.version, validation_state: cfg.validation_state,
      game_id: g.game_id != null ? String(g.game_id) : null, sport: leagueOf(input), league: leagueOf(input), market_key: marketKey(input, mt),
      home: g.home || null, away: g.away || null, kickoff: iso(g.kickoff),
      decision: 'NO_DECISION', bet_decision: 'NO_DECISION', decision_label: DECISIONS.NO_DECISION.label, decision_qualifier: null, decision_display: DECISIONS.NO_DECISION.label,
      decision_tone: DECISIONS.NO_DECISION.tone, headline: DECISIONS.NO_DECISION.headline,
      evaluation_status: 'NOT_EVALUABLE', blocker_codes: [], action_reason_code: null, action_reason_text: null, reasons: [], warning_codes: [],
      side: null, side_key: null, market_type: mt || 'spread', selected_line: null, selected_odds: null, selected_book: null, selected_is_alternate: false,
      recommended_units: 0, units: 0, shadow_units: 0, tier: null, strength: null, strength_label: null,
      recommended_dollars: null, unit_value: null,
      max_playable_line: null, max_acceptable_odds: null, playable: null,
      probability_source: null, probability_source_label: null, probability: null, break_even: null, edge_pp: null, decision_ev_pct: null,
      decision_confidence: null, decision_confidence_label: null, decision_confidence_detail: null,
      model_fair_line: null, model_fair_text: favText(null, fm, g.home, g.away), consensus_market_line: null,
      consensus_text: ch == null ? null : (Math.abs(ch) < 0.05 ? 'Pick’em' : (ch < 0 ? g.home : g.away) + ' -' + Math.abs(ch).toFixed(1).replace(/\.0$/, '')),
      model_market_gap: num(R.gap_pts), market_movement_pts: num(M.movement_pts), canonical: null,
      best_available: null, bet_price: null, reference_quote: null, selected_quote: null, best_value: null, safer_value: null, best_price: null, candidates: [],
      cover_probability: null, push_probability: null, break_even_probability: null, calibrated_cover_probability: null,
      raw_ev_pct: null, calibrated_ev_pct: null, risk_adjusted_score: null,
      reliability_score: num(Rl.score), reliability_label: Rl.grade || Rl.label || null,
      confidence_score: num(Cf.score), confidence_label: Cf.label || null,
      projection_stability: null, market_quality: null, independent_support_count: null,
      research_status: R.status || null, research_label: R.label || null,
      blockers: [], caps: [], warnings: [], invalidation_conditions: [], waiting_on: [], next_check: null, bet_trigger: null, watch: null,
      alternatives: null, anomaly: null, sizing: null, action: null,
      first_qualified_at: null, evaluated_at: iso(input.now), quote_captured_at: null,
      model_version: input.model ? input.model.model_version || null : null,
      pricing_model_version: (function () { try { return Q().VERSION; } catch (e) { return null; } })(),
      calibration_version: input.model && input.model.adjusted ? input.model.adjusted.version || null : null,
      governance: input.governance ? copy(input.governance) : null,
      projection: P.projected_home != null || P.p50 != null ? { home_points: num(P.projected_home), away_points: num(P.projected_away), p10: num(P.p10), p50: num(P.p50), p90: num(P.p90) } : null,
      transition: null,
      /* the quality-upgrade blocks (docs/bettor-decision/QUALITY_UPGRADE.md) */
      evaluation_mode: upper(input.evaluation_mode) || 'LIVE', versions: null, data_snapshot_at: null,
      context: input.context ? copy(input.context) : null,
      market: null, best_execution: null, ladder: null, price_curve: null
    };
  }
  function finish(out, cls, code, extra) {
    var D = DECISIONS[cls];
    out.decision = cls; out.bet_decision = cls; out.decision_label = D.label; out.decision_tone = D.tone; out.headline = D.headline;
    out.action_reason_code = code; out.action_reason_text = reasonText(code) + (extra ? ' ' + extra : '');
    if (cls === 'NO_DECISION') { out.evaluation_status = 'NOT_EVALUABLE'; out.decision_qualifier = null; }
    if (cls !== 'BET') { out.recommended_units = 0; out.units = 0; out.tier = null; out.strength = null; out.strength_label = null; out.playable = null; out.max_playable_line = null; out.max_acceptable_odds = null; out.recommended_dollars = null; }
    out.decision_display = D.label + (cls === 'BET' ? ' · ' + unitsText(out.recommended_units) : '') + (out.decision_qualifier ? ' · ' + out.decision_qualifier : '');
    out.warning_codes = (out.warnings || []).map(function (w) { return w.code; });
    out.action = actionBlock(out);
    out.decision_id = 'bd_' + hash([out.game_id, out.market_key, out.decision, out.action_reason_code, out.side_key, out.selected_line, out.selected_odds, out.selected_book, out.recommended_units, out.evaluated_at, out.model_version, out.calibration_version]);
    return out;
  }
  function block(out, code, text) {
    out.blockers.push({ code: code, text: text || reasonText(code), class: 'NO_DECISION' });
    out.blocker_codes.push(code);
  }
  function blocked(out, code, text) { block(out, code, text); return finish(out, 'NO_DECISION', code, text && text !== reasonText(code) ? text : null); }
  function attachQuote(out, input, c, asSelection) {
    if (!c) return;
    var o = c.o;
    out.side = o.team || teamOf(input, o.side); out.side_key = o.side;
    out.market_type = o.market_type === 'alternate_spread' ? 'spread' : (o.market_type || 'spread');
    out.selected_line = o.line; out.selected_odds = o.american_odds; out.selected_book = o.sportsbook; out.selected_is_alternate = !o.is_main_line && o.market_type !== 'moneyline' && o.market_type !== 'total';
    out.quote_captured_at = o.captured_at;
    out.cover_probability = o.model_cover_probability; out.push_probability = o.model_push_probability; out.break_even_probability = o.break_even_probability;
    out.calibrated_cover_probability = calCover(o);
    out.raw_ev_pct = isNum(o.expected_value) ? r(100 * o.expected_value, 2) : null;
    out.calibrated_ev_pct = isNum(calEv(o)) ? r(100 * calEv(o), 2) : null;
    out.decision_ev_pct = r(100 * c.ev, 2); out.probability = r(c.cover, 6); out.break_even = o.break_even_probability; out.edge_pp = r(c.edge_pp, 2);
    out.probability_source = c.source; out.probability_source_label = SOURCES[c.source].label;
    out.risk_adjusted_score = r(c.risk_adj, 5);
    out.independent_support_count = supportFor(input, o.side);
    if (o.market_type !== 'moneyline' && o.market_type !== 'total') {
      var f = fairLineForSide(input, o.side);
      out.model_fair_line = f; out.model_fair_text = f == null ? null : out.side + ' ' + lineText(r(f, 1));
      var mh = out.canonical && isNum(out.canonical.market_home_spread) ? out.canonical.market_home_spread : (input.market ? num(input.market.consensus_home_line) : null);
      out.consensus_market_line = mh == null ? null : (o.side === 'home' ? mh : -mh);
      out.consensus_text = mh == null ? null : out.side + ' ' + lineText(out.consensus_market_line);
    }
    var s = quoteSummary(o, c);
    out.selected_quote = s;
    if (asSelection) out.bet_price = s; else out.reference_quote = s;
  }

  /* LAYER A: identity, state and the model, shared by every market */
  function gameBlocker(input, cfg, mt) {
    var g = input.game || {}, I = input.integrity || {}, R = input.research || {};
    var mk = cfg.markets[marketKey(input, mt)];
    var st = gameState(input);
    if (g.game_id == null || g.game_id === '') return ['INVALID_GAME'];
    if (st === 'CANCELED' || st === 'CANCELLED') return ['GAME_CANCELLED'];
    if (st === 'POSTPONED') return ['GAME_POSTPONED'];
    if (st === 'SUSPENDED') return ['GAME_SUSPENDED'];
    var ko = ms(g.kickoff), now = ms(input.now);
    if (st === 'IN_PROGRESS' || st === 'FINAL' || st === 'FINISHED' || (ko != null && now != null && now >= ko)) return ['GAME_STARTED'];
    if (g.duplicate) return ['DUPLICATE_GAME'];
    if (g.mapping_ok === false) return ['MAPPING_FAILED', g.mapping_reason || null];
    if (!mk || !mk.supported) return ['UNSUPPORTED_MARKET'];
    /* a DATA FAULT is essential; a gap past the guard is only suspicious */
    var fault = I.data_fault || R.status === 'DATA_FAULT', kind = upper(I.data_fault_kind);
    if (fault && kind !== 'GUARD' && kind !== 'ORIENTATION') return ['DATA_FAULT', I.data_fault_reason || R.reason || null];
    if (!input.model || !input.model.available) return ['MODEL_UNAVAILABLE', input.model && input.model.reason || null];
    if (!input.model.model_version) return ['MODEL_VERSION_UNKNOWN'];
    if (I.malformed_projection) return ['MALFORMED_PROJECTION', I.malformed_reason || null];
    if (I.self_check_ok === false) return ['SELF_CHECK_FAILED', I.self_check_reason || null];
    if ((input.qb || {}).projection_invalid) return ['QB_PROJECTION_INVALID', (input.qb || {}).detail || null];
    return null;
  }
  function softCtx(input, cfg) {
    var I = input.integrity || {}, R = input.research || {}, g = input.game || {}, base = input.qev_ctx || {};
    var fault = I.data_fault || R.status === 'DATA_FAULT', kind = upper(I.data_fault_kind);
    /* a DATA FAULT raised only by the gap guard or by a sign heuristic is a
       suspicion about the NUMBER; the quotes themselves are team-labelled */
    var guard = fault && kind === 'GUARD' ? { reason: I.data_fault_reason || R.reason || null } : null;
    var sign = null;
    if (fault && kind === 'ORIENTATION') sign = { reason: I.data_fault_reason || R.reason || 'the joined market line only agreed with the model once negated' };
    if (g.orientation_ok === false || (base.orientation && base.orientation.ok === false)) sign = { reason: g.orientation_reason || (base.orientation && base.orientation.reason) || 'orientation check' };
    if (g.sign_suspect) sign = { reason: g.sign_suspect.reason || g.sign_suspect };
    if (base.sign_suspect && !sign) sign = base.sign_suspect;
    return { guard: guard, sign_suspect: sign, market_check_failed: !!base.market_check_failed, market_check_reason: base.market_check_reason || null };
  }

  /* ======================================================= THE SPREAD */
  function decideSpread(input, cfg) {
    var out = skeleton(input, cfg, 'spread');
    var league = leagueOf(input), L = cfg.leagues[league] || cfg.leagues.CFB;
    var mk = cfg.markets[marketKey(input, 'spread')] || { supported: false };
    var M = input.market || {};
    var prevDecision = input.previous ? input.previous.decision : null;

    /* ---------------- LAYER A ---------------- */
    var gb = gameBlocker(input, cfg, 'spread');
    if (gb) return blocked(out, gb[0], gb[1] || null);
    if (typeof input.model.home_cover !== 'function' && !(input.evaluation && input.evaluation.sides)) return blocked(out, 'DISTRIBUTION_MISSING');
    var raw = input.quotes || (input.evaluation && input.evaluation.sides ? quotesFromEvaluation(input.evaluation) : []);
    raw = raw.filter(function (q) { var m = q && marketOf(q); return m === 'spread' || m === 'alternate_spread'; });
    if (M.available === false || !raw.length) return blocked(out, 'NO_MARKET');
    if (M.suspended) return blocked(out, 'MARKET_SUSPENDED');
    if ((input.game || {}).orientation_ambiguous) return blocked(out, 'ORIENTATION_FAULT', (input.game || {}).orientation_reason || null);
    var norm = normalizeQuotes(raw, input.game || {});
    if (!norm.quotes.length) return blocked(out, 'ORIENTATION_FAULT', norm.dropped.map(function (d) { return d.quote + ': ' + d.text; }).slice(0, 3).join('; ') || null);
    /* ONE consensus line: the canonical market's (the research card's rule),
       so the gap, the review and every surface read the same number */
    var mcons = marketConsensus(norm.quotes, 'spread', league, input.now);
    norm.mode_home_line = norm.consensus_home_line;
    if (mcons && isNum(mcons.consensus)) norm.consensus_home_line = mcons.consensus;
    var soft = softCtx(input, cfg);
    var ctx2 = qevCtx(input);
    var lifted = (ctx2.orientation && ctx2.orientation.ok === false) || ctx2.market_check_failed || (soft.guard && (ctx2.data_fault || ctx2.research_status === 'DATA_FAULT'));
    ctx2.orientation = { ok: true };
    ctx2.market_check_failed = false;
    if (soft.guard || soft.sign_suspect) { if (ctx2.data_fault) lifted = true; ctx2.data_fault = false; if (ctx2.research_status === 'DATA_FAULT') ctx2.research_status = null; }
    if (soft.sign_suspect) ctx2.sign_suspect = soft.sign_suspect;
    if (!isNum(ctx2.max_age_minutes)) ctx2.max_age_minutes = cfg.freshness.max_quote_age_minutes;
    /* the caller's own evaluation is reused when nothing about the quotes or
       the gates changed, so the board and the decision read the same objects */
    var reuse = !lifted && !norm.changed && !soft.sign_suspect && !!(input.evaluation && input.evaluation.sides);
    var G = null;
    try { G = reuse ? input.evaluation : Q().evaluateGame(input.model, norm.quotes, ctx2); }
    catch (e) { return blocked(out, 'NO_VALID_QUOTE', 'pricing failed: ' + String(e && e.message || e).slice(0, 120)); }
    input._evaluation = G; input._qctx = ctx2;
    var priced = allPriced(G);
    var avail = priced.filter(function (o) { return o.ev_available; });
    var clean = avail.filter(function (o) { return !hasFlag(o, INTEGRITY_FLAGS); });
    var canon0 = canonicalOf(input, norm, null);
    out.canonical = canon0;
    /* THE SIDE INVARIANT FAILS LOUDLY (audit 2026-09-30): a +EV quote on the
       side the displayed model is past the market AGAINST is a pricing bug */
    if (G && G.side_invariant && G.side_invariant.ok === false) return blocked(out, 'EV_SIDE_CONTRADICTION', G.side_invariant.reason);
    if (!avail.length) {
      var codes = priced.map(function (o) { return o.ev_unavailable_code; });
      if (codes.indexOf('STALE') >= 0 || M.stale) {
        var prevQ = input.previous && (input.previous.bet_price || input.previous.reference_quote);
        /* the last known quote, named: a tracker's record carries no label or team */
        if (prevQ) { var pt = prevQ.team || teamOf(input, prevQ.side); out.reference_quote = assign({}, prevQ, { team: pt || null, label: prevQ.label || ((pt || prevQ.side || '?') + ' ' + lineText(num(prevQ.line)) + ' (' + priceText(num(prevQ.odds)) + ')'), last_known: true }); }
        return blocked(out, 'STALE_QUOTE', prevDecision === 'BET' && input.previous.bet_price ? 'The earlier BET at ' + lineText(input.previous.bet_price.line) + ' (' + priceText(input.previous.bet_price.odds) + ') is not current until a fresh quote confirms it.' : null);
      }
      if (codes.indexOf('QUOTE_TIME_UNKNOWN') >= 0) return blocked(out, 'FRESHNESS_UNKNOWN');
      if (codes.indexOf('DISTRIBUTION_FAULT') >= 0) return blocked(out, 'IMPOSSIBLE_PROBABILITY');
      if (codes.indexOf('INVALID_PRICE') >= 0 || codes.indexOf('NO_PRICE') >= 0) return blocked(out, 'CORRUPTED_ODDS', 'no quote carries a valid sportsbook price');
      if (codes.indexOf('DATA_FAULT') >= 0) return blocked(out, 'DATA_FAULT');
      if (codes.indexOf('INVALID_GAME') >= 0) return blocked(out, 'INVALID_GAME');
      if (codes.indexOf('NO_MODEL') >= 0) return blocked(out, 'DISTRIBUTION_MISSING');
      if (codes.indexOf('MODEL_VERSION') >= 0) return blocked(out, 'MODEL_VERSION_UNKNOWN');
      return blocked(out, 'NO_VALID_QUOTE', G && G.ev_unavailable_reason || null);
    }
    if (!clean.length) return blocked(out, 'CORRUPTED_ODDS', 'every priced quote failed an arithmetic integrity check (' + flagCodes(avail[0]).filter(function (x) { return INTEGRITY_FLAGS.indexOf(x) >= 0; }).join(', ').toLowerCase() + ')');
    out.evaluation_status = 'EVALUABLE';

    /* ---------------- LAYER B ---------------- */
    var cands = clean.map(function (o) {
      var m = metricsOf(o);
      if (!m) return null;
      var dir = directionTowardSide(canon0, o.side);
      if (isNum(dir)) m.direction_agrees = dir >= -(L.aligned_gap_pts || 0) - EPS;
      m.price_cls = priceClass(m, cfg);
      m.cls = m.price_cls;
      m.quote_caps = [];
      if (!tailOk(o) && CLASS_RANK[m.cls] > CLASS_RANK.LEAN) { m.cls = 'LEAN'; m.quote_caps.push('TAIL_UNVALIDATED'); }
      return m;
    }).filter(Boolean);
    if (!cands.length) return blocked(out, 'IMPOSSIBLE_PROBABILITY');
    cands.sort(function (a, b) { return preferred(a, b) ? -1 : (preferred(b, a) ? 1 : 0); });
    var mq0 = null, stab = stabilityOf(input);
    var rctx = { input: input, cfg: cfg, league: league, league_cfg: L, priced: priced, G: G, canon: canon0, norm: norm, sign_suspect: soft.sign_suspect, guard: soft.guard,
      market_check_failed: soft.market_check_failed, market_check_reason: soft.market_check_reason, mcons: mcons };
    /* the recommendation: the most preferred candidate whose price verifies */
    var sel = null, review = null, skipped = [];
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].cls === 'PASS') break;
      var rv = priceReview(cands[i], rctx);
      if (!rv.triggered || rv.cleared) { sel = cands[i]; review = rv; break; }
      cands[i].price_unverified = true;
      skipped.push({ quote: cands[i].o.label, book: cands[i].o.sportsbook, review: rv });
      if (skipped.length >= 6) break;
    }
    var anomalyOpen = false;
    if (!sel && skipped.length) { sel = cands[0]; review = skipped[0].review; anomalyOpen = true; }
    /* nothing positive anywhere: the reference is the model's side at its best main-line price */
    if (!sel) {
      var towards = canon0.gap_toward_side;
      var mainsOn = cands.filter(function (c) { return c.o.is_main_line && (!towards || c.o.side === towards); });
      sel = (mainsOn.length ? mainsOn : cands).slice().sort(function (a, b) { return (b.ev - a.ev) || (b.o.line - a.o.line); })[0];
      review = priceReview(sel, rctx);
      anomalyOpen = false;
    }
    var canon = canonicalOf(input, norm, sel.o);
    out.canonical = canon;
    rctx.canon = canon;
    out.market = marketCanon(input, norm.quotes, sel.o, 'spread', league, norm, canon.fair_home_spread);
    var mq = marketQuality(input, sel.o, priced, cfg, out.market);
    mq0 = mq;
    out.market_quality = mq; out.projection_stability = stab;
    out.anomaly = review ? assign({}, review, { open: anomalyOpen, skipped_quotes: skipped.map(function (s) { return s.quote + (s.book ? ' @ ' + s.book : ''); }) }) : null;
    var inconsistent = ((G && G.flags) || []).some(function (f) { return INCONSISTENT_FLAGS.indexOf(f.code) >= 0; });
    var conf = decisionConfidence(input, sel, mq, stab, anomalyOpen ? assign({}, review, { suspicious: true }) : review, sel.source, cfg, { inconsistent: inconsistent });
    out.decision_confidence = conf.score; out.decision_confidence_label = conf.label; out.decision_confidence_detail = conf;
    var wctx = { cfg: cfg, mq: mq, stab: stab, canon: canon, league: league, league_cfg: L, review: review && review.cleared ? review : null, norm: norm, source: sel.source };
    out.warnings = warningsOf(input, sel, wctx);
    attachQuote(out, input, sel, false);
    /* BEST CURRENT PRICE: the best book for the exact line evaluated — never
       the side's widest number, which an off-market row or an extreme
       alternate could win */
    var bcp = bestPriceAt(priced, sel.o.side, sel.o.line, cands.filter(function (c) { return c.price_unverified && c !== sel; }).map(function (c) { return c.o; }));
    if (bcp) { out.best_current_price = quoteSummary(bcp); out.best_available = out.best_current_price; }
    out.candidates = cands.slice(0, cfg.max_candidates_reported).map(candSummary);

    /* the caps: missing optional data lowers the class, never blocks it */
    var caps = [], qb = input.qb || {}, av = input.availability || {}, R = input.research || {};
    function cap(code, max, text) { caps.push({ code: code, max: max, text: text || reasonText(code), resolution: RESOLUTION[code] || null }); }
    /* THE EV SANITY GUARD (audit 2026-09-30): an implausible raw EV on any
       main-line spread caps the whole game at WATCH — no review clears it */
    if (G && G.implausible_ev) cap('IMPLAUSIBLE_EV', 'WATCH', G.implausible_ev.reason);
    /* THE STAKE BRAKE (audit follow-up #2): the research bound is σ-scaled so a
       VERIFIED 7+ gap can read VERIFIED MAJOR; the flat 25% raw-EV line the
       first pass drew stays here, on the STAKE, so no bet is loosened */
    else if (G && G.large_ev) cap('LARGE_EV', 'WATCH', G.large_ev.reason);
    if (anomalyOpen) cap('PRICE_ANOMALY', 'WATCH', reasonText('PRICE_ANOMALY') + ' Quote: ' + sel.o.label + (sel.o.sportsbook ? ' at ' + sel.o.sportsbook : '') + (sel.o.is_main_line ? '' : ' (alternate)') + '. Open checks: ' + review.checks.filter(function (c) { return c.status !== 'PASS'; }).map(function (c) { return c.code.replace(/_/g, ' ').toLowerCase() + ' ' + c.status.toLowerCase(); }).join('; ') + '.');
    if (qb.unresolved_critical) cap('QB_UNRESOLVED', 'WATCH', reasonText('QB_UNRESOLVED') + (qb.detail ? ' (' + qb.detail + ')' : ''));
    else if (qb.known === false) cap('QB_UNKNOWN', 'WATCH');
    if (av.major_uncertainty || av.pending) cap('AVAILABILITY_PENDING', 'WATCH', reasonText('AVAILABILITY_PENDING') + (av.detail ? ' (' + av.detail + ')' : ''));
    if (mq === 'THIN') cap('THIN_MARKET', 'LEAN');
    if (conf.score < cfg.gates.min_decision_confidence) cap('LOW_DECISION_CONFIDENCE', 'LEAN', 'Decision confidence ' + conf.score + ' is under the betting floor (' + cfg.gates.min_decision_confidence + ').');
    var rel = input.reliability ? num(input.reliability.score) : null;
    if (rel != null && rel < cfg.gates.min_reliability) cap('LOW_RELIABILITY', 'LEAN', 'Reliability ' + Math.round(rel) + ' is under the betting floor (' + cfg.gates.min_reliability + ').');
    var fc = input.confidence ? num(input.confidence.score) : null;
    if (fc != null && fc < cfg.gates.min_model_confidence) cap('LOW_MODEL_CONFIDENCE', 'LEAN', 'Football confidence ' + Math.round(fc) + ' is under the betting floor (' + cfg.gates.min_model_confidence + ').');
    if (cfg.gates.reject_low_stability && stab === 'LOW') cap('UNSTABLE_PROJECTION', 'LEAN');
    if (mk.max_class && mk.max_class !== 'BET') cap('MARKET_NOT_VALIDATED', mk.max_class);
    var gov = input.governance || {};
    if (mk.bet_authority === 'GOVERNED_POLICY' && gov.policy_bet_enabled !== true) cap('BET_AUTHORITY_DISABLED', 'LEAN');
    if (mk.bet_authority === 'NONE') cap('BET_AUTHORITY_DISABLED', 'LEAN');
    sel.quote_caps.forEach(function (q) { cap(q, 'LEAN'); });
    /* THE MODEL MUST AGREE WITH ITSELF. On the number the decision reads, a
       fair line on the OTHER side (beyond the league's aligned band) while
       the model's OWN (raw) cover probability is above 50% is a distribution
       off-centre at this number (tools/validation/model_health.js
       distribution audit), not an edge. It is the raw model contradicting
       itself: a validated calibration that moves the probability across the
       raw fair line is the calibration doing its job (calibrated EV decides),
       and is not capped here. A plus-money alternate on the other side is
       untouched: its cover is below 50%, and its value is the price. */
    var dirSel = directionTowardSide(canon, sel.o.side), lineGap = null;
    if (isNum(sel.o.line)) {
      var fSide = isNum(canon.decision_fair_home_spread) ? (sel.o.side === 'home' ? canon.decision_fair_home_spread : -canon.decision_fair_home_spread) : fairLineForSide(input, sel.o.side);
      if (isNum(fSide)) lineGap = sel.o.line - fSide;
    }
    if (isNum(lineGap) && lineGap < -((L.aligned_gap_pts || 0) + EPS) && isNum(sel.raw_cover) && sel.raw_cover > 0.5 + EPS && sel.cover > 0.5 + EPS && CLASS_RANK[sel.price_cls] >= CLASS_RANK.LEAN)
      cap('MODEL_CONFLICT', 'WATCH', reasonText('MODEL_CONFLICT') + ' (' + (sel.o.team || sel.o.side) + ' ' + lineText(sel.o.line) + ' against a fair ' + lineText(r(sel.o.line - lineGap, 1)) + ', model cover ' + probText(sel.raw_cover) + ').');
    out.caps = caps;
    /* every evaluable return goes through done(): the execution layer reads
       the same caps, confidence and review the decision used */
    var xctx = { cfg: cfg, L: L, canon: canon, caps: caps, conf: conf, review: review, mq: mq, warnings: out.warnings, gSide: gapTowardSide(canon, sel.o.side), fairSide: isNum(lineGap) ? sel.o.line - lineGap : null };
    function done(k, code, extra) { attachExecution(out, input, sel, xctx, k); return finish(out, k, code, extra); }

    /* the class: the price's, then the tightest cap */
    var cls = sel.price_cls, code = null, binding = null;
    caps.forEach(function (c) { if (CLASS_RANK[c.max] < CLASS_RANK[cls]) { cls = c.max; binding = c; } });
    var reasons = [];
    function rsn(x) { if (reasons.indexOf(x) < 0) reasons.push(x); }
    rsn(sel.ev > 0 ? 'POSITIVE_EV' : 'NEGATIVE_EV');
    rsn(meets(sel, cfg.thresholds.bet) ? 'EDGE_THRESHOLD_PASSED' : 'EDGE_BELOW_BET_THRESHOLD');
    rsn(quoteFresh(sel.o) && !(isNum(sel.o.quote_age_minutes) && sel.o.quote_age_minutes > cfg.freshness.max_quote_age_minutes) ? 'QUOTE_FRESH' : 'QUOTE_AGING');
    rsn(sel.source === 'calibrated' ? 'CALIBRATED_PROBABILITY' : (sel.source === 'partially_calibrated' ? 'PARTIALLY_CALIBRATED_PROBABILITY' : 'MODEL_ESTIMATED_PROBABILITY'));
    var gSide = gapTowardSide(canon, sel.o.side);
    if (isNum(gSide) && gSide >= L.watch_gap_pts) rsn('MODEL_MARKET_DISAGREEMENT');
    if (isNum(canon.gap_pts) && canon.gap_pts <= L.aligned_gap_pts) rsn('MARKET_ALIGNED');
    if (!sel.o.is_main_line) rsn('ALTERNATE_SELECTED');
    if (out.best_available && out.best_available.book === sel.o.sportsbook && out.best_available.line === sel.o.line) rsn('BEST_PRICE_SELECTED');
    if (sel.key_number_value_pp > 0) rsn('KEY_NUMBER_VALUE');
    if (review && review.triggered) rsn(review.cleared ? 'ANOMALY_CLEARED' : 'PRICE_ANOMALY');
    if (norm.status === 'REPAIRED') rsn('ORIENTATION_REPAIRED');
    if (mq === 'VERIFIED' || mq === 'STRONG') rsn('TWO_SIDED_MARKET');
    var altsOn = cands.filter(function (c) { return !c.o.is_main_line; });
    if (altsOn.length && !altsOn.some(function (c) { return c.ev > 0; })) rsn('ALTERNATES_NO_IMPROVEMENT');

    /* the trigger, for every non-BET: what would make it actionable */
    var trig = null;
    if (cls !== 'BET' || binding) { try { trig = betTrigger(input, sel.o, cfg); } catch (e) { trig = null; } }

    if (cls === 'BET' && !binding) {
      /* sizing, the last gate */
      var Z = sizing(input, sel, { cfg: cfg, confidence: conf, review: review, mq: mq, canon: canon, league_cfg: L, warnings: out.warnings });
      out.sizing = Z; out.shadow_units = Z.shadow_units;
      if (!(Z.units > 0)) { cls = 'LEAN'; binding = { code: 'SIZING_ZERO', max: 'LEAN', text: reasonText('SIZING_ZERO') + (Z.caps.length ? ' (' + Z.caps.join('; ') + ')' : '') }; caps.push(binding); try { trig = betTrigger(input, sel.o, cfg); } catch (e) { trig = null; } }
      else {
        out.recommended_units = Z.units; out.units = Z.units; out.tier = Z.tier; out.strength = Z.tier; out.strength_label = STRENGTH[Z.tier] ? STRENGTH[Z.tier].label : null;
        out.decision_qualifier = sel.source === 'calibrated' ? null : SOURCES[sel.source].label;
        attachQuote(out, input, sel, true);
        out.reference_quote = null;
        if (bcp) { out.best_current_price = quoteSummary(bcp); out.best_available = out.best_current_price; }
        var pl = null; try { pl = playable(input, sel.o, cfg); } catch (e) { pl = null; }
        out.playable = pl; out.max_playable_line = pl ? pl.min_line : sel.o.line; out.max_acceptable_odds = pl ? pl.max_odds : sel.o.american_odds;
        out.invalidation_conditions = invalidationOf(input, sel.o, pl);
        out.first_qualified_at = input.track && input.track.first_qualified ? input.track.first_qualified.at : out.evaluated_at;
        rsn('UNITS_SIZED');
        alternatives(out, input, sel, cands, priced, cfg);
        out.reasons = reasons;
        return done('BET', 'QUALIFIES');
      }
    }
    alternatives(out, input, sel, cands, priced, cfg);
    out.bet_trigger = trig;
    if (binding) {
      out.decision_qualifier = QUALIFIER[binding.code] || null;
      if (cls === 'WATCH' || cls === 'LEAN') {
        out.watch = { reason_code: binding.code, text: binding.text, resolution: binding.resolution,
          trigger: binding.resolution ? 'Becomes eligible for BET once ' + binding.resolution + (sel.price_cls === 'BET' ? ', if the price holds.' : (trig && trig.short ? ' and the price reaches ' + trig.short + '.' : '; the current price would also need to improve, and no realistic price change clears the threshold on its own.')) : (trig ? trig.text : null) };
        out.waiting_on.push({ code: binding.code, text: binding.resolution || binding.text });
        out.next_check = 'EdgeDesk re-evaluates automatically when the information or the price changes.';
      }
      out.reasons = reasons;
      var base = reasonText(binding.code), bt = binding.text || base;
      return done(cls, binding.code, bt === base ? null : (bt.indexOf(base) === 0 ? bt.slice(base.length).trim() || null : bt));
    }
    if (cls === 'LEAN') {
      out.watch = trig && trig.short ? { reason_code: 'LEAN_EDGE', text: reasonText('LEAN_EDGE'), trigger: trig.text } : null;
      out.reasons = reasons;
      return done('LEAN', 'LEAN_EDGE');
    }
    /* WATCH-for-price or PASS */
    var near = nearTrigger(trig, L);
    if (cls === 'WATCH' || near) {
      /* WATCH names what it waits for: a near trigger, or a meaningful
         disagreement whose BET trigger is a realistic move. A disagreement
         no realistic price can turn into a BET is a PASS. */
      var wcode = near ? 'NEAR_THRESHOLD' : (isNum(gSide) && gSide >= L.watch_gap_pts && trig && trig.realistic && trig.short ? 'MODEL_MARKET_DISAGREEMENT' : null);
      if (wcode) {
        out.decision_qualifier = QUALIFIER[wcode];
        out.watch = { reason_code: wcode, text: reasonText(wcode), trigger: trig ? trig.text : null };
        out.waiting_on.push({ code: 'PRICE', text: trig && trig.short ? 'the price reaching ' + trig.short : 'a better price' });
        out.next_check = 'EdgeDesk re-evaluates automatically whenever the market moves.';
        out.reasons = reasons;
        return done('WATCH', wcode);
      }
    }
    /* PASS: evaluable, not worth a wager — and exactly why */
    var pcode, pb0 = input.previous && input.previous.bet_price, moved = '';
    var samePrice = pb0 && pb0.side === sel.o.side && Math.abs(num(pb0.line) - sel.o.line) < EPS && Math.round(num(pb0.odds)) === Math.round(sel.o.american_odds);
    if (prevDecision === 'BET' && samePrice) pcode = 'PROJECTION_CHANGED';
    else if (prevDecision === 'BET') pcode = 'PRICE_MOVED';
    else if (sel.ev > 0) pcode = 'EDGE_TOO_SMALL';
    else if (isNum(sel.calibrated_ev) && isNum(sel.raw_ev) && sel.raw_ev > 0 && sel.calibrated_ev <= 0) pcode = 'CALIBRATED_EV_NEGATIVE';
    else if (isNum(canon.gap_pts) && canon.gap_pts <= L.aligned_gap_pts) pcode = 'MARKET_ALIGNED';
    else if (sel.direction_agrees && sel.ev <= 0) pcode = 'JUICE_CONSUMES_EDGE';
    else pcode = 'NO_MODEL_EDGE';
    if (pcode === 'PRICE_MOVED' && pb0) moved = 'Line moved from ' + lineText(pb0.line) + ' (' + priceText(pb0.odds) + ') to ' + lineText(sel.o.line) + ' (' + priceText(sel.o.american_odds) + ') and crossed EdgeDesk’s playable threshold.';
    out.reasons = reasons;
    return done('PASS', pcode, moved || null);
  }
  /* the best book for one exact line on one side (clean, priced, verified) */
  function bestPriceAt(priced, side, line, bad) {
    var best = null;
    (priced || []).forEach(function (o) {
      if (!o.ev_available || o.side !== side || hasFlag(o, INTEGRITY_FLAGS) || (bad && bad.indexOf(o) >= 0)) return;
      if (isNum(line) ? !(isNum(o.line) && Math.abs(o.line - line) < EPS) : o.line != null) return;
      if (!best || o.decimal_odds > best.decimal_odds + EPS) best = o;
    });
    return best;
  }
  /* an alternate may be offered beside the recommendation only when it is a
     NEARBY line at an EXECUTABLE price: +28.5 (-10000) never wins a "best" field */
  function executableQuote(o, cfg) { var A = cfg.alternates || {}; return isNum(o.american_odds) && o.american_odds >= (isNum(A.min_odds) ? A.min_odds : -300) - EPS && o.american_odds <= (isNum(A.max_odds) ? A.max_odds : 300) + EPS; }
  function nearbyQuote(o, ref, cfg) { var A = cfg.alternates || {}; if (!isNum(o.line) || !isNum(ref.line)) return o.line == null && ref.line == null; return Math.abs(o.line - ref.line) <= (isNum(A.nearby_points) ? A.nearby_points : 3) + EPS; }
  /* BEST CURRENT PRICE / BEST PLAYABLE ALTERNATE / SAFER ALTERNATE for the
     selected side. The recommendation itself (best_value) is the selection. */
  function alternatives(out, input, sel, cands, priced, cfg) {
    cfg = cfg || resolveConfig(null);
    var side = sel.o.side;
    /* a quote that failed price verification is never offered as an alternative */
    var bad = cands.filter(function (c) { return c.price_unverified && c !== sel; }).map(function (c) { return c.o; });
    var same = cands.filter(function (c) { return c.o.side === side && (c === sel || !c.price_unverified); });
    var pool = same.filter(function (c) { return c !== sel && executableQuote(c.o, cfg) && nearbyQuote(c.o, sel.o, cfg); });
    var safer = null;
    /* SAFER: a DIFFERENT line with more cushion (never the same number at a
       worse price from another book), lower variance, still positive EV */
    pool.forEach(function (c) {
      if (!(c.ev > 0) || !isNum(c.sd) || !isNum(sel.sd) || !(c.sd < sel.sd - EPS)) return;
      if (!(isNum(c.o.line) && isNum(sel.o.line) && c.o.line > sel.o.line + EPS)) return;
      if (!safer || c.cover > safer.cover + EPS) safer = c;
    });
    var playableAlt = null;
    pool.forEach(function (c) {
      if (c.cls !== 'BET' || !tailOk(c.o) || (isNum(c.o.line) && isNum(sel.o.line) && Math.abs(c.o.line - sel.o.line) < EPS)) return;
      if (!playableAlt || preferred(c, playableAlt)) playableAlt = c;
    });
    var bestPrice = bestPriceAt(priced, side, sel.o.line, bad);
    var main = null;
    priced.forEach(function (o) { if (o.side === side && o.is_main_line && o.ev_available && bad.indexOf(o) < 0 && (!main || o.line > main.line + EPS || (Math.abs(o.line - main.line) < EPS && o.decimal_odds > main.decimal_odds))) main = o; });
    var maxEv = null;
    pool.concat([sel]).forEach(function (c) { if (!maxEv || c.ev > maxEv.ev + EPS) maxEv = c; });
    out.best_value = quoteSummary(sel.o, sel);
    out.safer_value = safer ? quoteSummary(safer.o, safer) : null;
    out.best_price = bestPrice ? quoteSummary(bestPrice) : null;
    out.best_current_price = out.best_price;
    out.best_available = out.best_current_price;
    out.best_playable_alternate = playableAlt ? quoteSummary(playableAlt.o, playableAlt) : null;
    var A = cfg.alternates || {};
    out.alternatives = { best_value: out.best_value, best_current_price: out.best_current_price, best_playable_alternate: out.best_playable_alternate,
      safer: out.safer_value, safer_alternate: out.safer_value, aggressive_alternate: null, best_price: out.best_price, main: main ? quoteSummary(main) : null,
      better_value: maxEv && maxEv !== sel ? quoteSummary(maxEv.o, maxEv) : null,
      n_evaluated: cands.length, n_alternates: cands.filter(function (c) { return !c.o.is_main_line; }).length,
      rules: { nearby_points: A.nearby_points, min_odds: A.min_odds, max_odds: A.max_odds },
      note: 'BEST CURRENT PRICE is the best book for the exact line evaluated. BEST PLAYABLE ALTERNATE is a nearby line (within ' + A.nearby_points + ' pts, odds ' + priceText(A.min_odds) + ' to ' + priceText(A.max_odds) + ') on the same side that also clears the BET threshold; SAFER ALTERNATE is a nearby lower-variance line that keeps positive EV. An extreme longshot or ultra-safe alternate is never offered, and the biggest raw EV is not automatically the best wager.' };
  }

  /* ============================================= TOTALS AND MONEYLINES
     Each market decides alone: a missing totals distribution makes the total
     NO DECISION and leaves the spread untouched. */
  function decideOther(input, cfg, mt) {
    var out = skeleton(input, cfg, mt);
    var league = leagueOf(input), L = cfg.leagues[league] || cfg.leagues.CFB;
    var mk = cfg.markets[marketKey(input, mt)] || { supported: false };
    var gb = gameBlocker(input, cfg, mt);
    if (gb) return blocked(out, gb[0], gb[1] || null);
    var model = input.model;
    var raw = (input.quotes || []).filter(function (q) { return q && marketOf(q) === mt; });
    if (!raw.length) return blocked(out, 'NO_MARKET');
    if (mt === 'total' && typeof model.total_cover !== 'function') return blocked(out, 'DISTRIBUTION_MISSING', model.total_calibration && model.total_calibration.reason ? '(' + model.total_calibration.reason + ')' : null);
    if (mt === 'moneyline' && !isNum(num(model.moneyline && model.moneyline.home_win_prob))) return blocked(out, 'DISTRIBUTION_MISSING');
    var norm = normalizeQuotes(raw, input.game || {});
    if (!norm.quotes.length) return blocked(out, 'ORIENTATION_FAULT');
    var ctx2 = assign(qevCtx(input), { orientation: { ok: true }, market_check_failed: false, decision_pricing: true });
    if (!isNum(ctx2.max_age_minutes)) ctx2.max_age_minutes = cfg.freshness.max_quote_age_minutes;
    var soft = softCtx(input, cfg);
    if (soft.guard || soft.sign_suspect) { ctx2.data_fault = false; if (ctx2.research_status === 'DATA_FAULT') ctx2.research_status = null; }
    input = assign({}, input, { _qctx: ctx2, _evaluation: null });
    var priced = norm.quotes.map(function (q) { var team = q.side === 'home' ? (input.game || {}).home : (q.side === 'away' ? (input.game || {}).away : null); return Q().priceQuote(model, assign({}, q, { team: q.team || team, game_id: q.game_id != null ? q.game_id : (input.game || {}).game_id }), ctx2); });
    var avail = priced.filter(function (o) { return o.ev_available && !hasFlag(o, INTEGRITY_FLAGS); });
    var flagged = priced.filter(function (o) { return o.ev_available && hasFlag(o, INTEGRITY_FLAGS); });
    if (!avail.length && flagged.length) return blocked(out, 'CORRUPTED_ODDS', 'every priced quote failed an arithmetic integrity check (' + flagCodes(flagged[0]).filter(function (x) { return INTEGRITY_FLAGS.indexOf(x) >= 0; }).join(', ').toLowerCase() + ')');
    if (!avail.length) {
      var codes = priced.map(function (o) { return o.ev_unavailable_code; });
      if (codes.indexOf('STALE') >= 0) return blocked(out, 'STALE_QUOTE');
      if (codes.indexOf('QUOTE_TIME_UNKNOWN') >= 0) return blocked(out, 'FRESHNESS_UNKNOWN');
      if (codes.indexOf('INVALID_PRICE') >= 0 || codes.indexOf('NO_PRICE') >= 0) return blocked(out, 'CORRUPTED_ODDS');
      if (codes.indexOf('DISTRIBUTION_FAULT') >= 0 || codes.indexOf('LINE_UNSUPPORTED') >= 0) return blocked(out, 'IMPOSSIBLE_PROBABILITY');
      return blocked(out, 'NO_VALID_QUOTE');
    }
    out.evaluation_status = 'EVALUABLE';
    var calOk = mt === 'moneyline' ? !!(model.moneyline && model.moneyline.calibration && model.moneyline.calibration.validated) : !!(model.total_calibration && model.total_calibration.validated);
    /* a moneyline's direction is the edge's: a win probability above the
       vigged break-even is above the market's own, underdog or not */
    var cands = avail.map(function (o) { var m = metricsOf(o); if (!m) return null; if (mt === 'moneyline') m.direction_agrees = m.edge > EPS; m.source = calOk ? 'partially_calibrated' : 'model_estimated'; m.price_cls = priceClass(m, cfg); m.cls = m.price_cls; m.quote_caps = []; return m; }).filter(Boolean);
    cands.sort(function (a, b) { return preferred(a, b) ? -1 : (preferred(b, a) ? 1 : 0); });
    /* an off-market book is not the recommendation while another book is on the market */
    var mconsO = marketConsensus(norm.quotes, mt, league, input.now);
    var offOf = function (c) { return mconsO && MK() ? MK().outlierText(mconsO, { side: c.o.side, line: c.o.line, american: c.o.american_odds, book: c.o.sportsbook, market_type: mt }, c.o.team) : null; };
    cands.forEach(function (c) { c.off_market = offOf(c); if (c.off_market) c.price_unverified = true; });
    var onMarket = cands.filter(function (c) { return !c.off_market && c.cls !== 'PASS'; });
    var sel = onMarket.length ? onMarket[0] : cands[0];
    out.market = marketCanon(input, norm.quotes, sel.o, mt, league, norm, null);
    var mq = marketQuality(input, sel.o, priced, cfg, out.market), stab = stabilityOf(input);
    out.market_quality = mq; out.projection_stability = stab;
    var extreme = isNum(sel.raw_ev) && sel.raw_ev >= cfg.anomaly.raw_ev;
    var conf = decisionConfidence(input, sel, mq, stab, extreme ? { triggered: true, suspicious: true, checks: [] } : null, sel.source, cfg, {});
    out.decision_confidence = conf.score; out.decision_confidence_label = conf.label; out.decision_confidence_detail = conf;
    out.warnings = warningsOf(input, sel, { cfg: cfg, mq: mq, stab: stab, canon: null, league: league, league_cfg: L, source: sel.source });
    attachQuote(out, input, sel, false);
    out.candidates = cands.slice(0, cfg.max_candidates_reported).map(candSummary);
    var caps = [], qb = input.qb || {}, av = input.availability || {};
    function cap(code, max, text) { caps.push({ code: code, max: max, text: text || reasonText(code), resolution: RESOLUTION[code] || null }); }
    if (extreme) cap('PRICE_ANOMALY', 'WATCH', reasonText('PRICE_ANOMALY') + ' Raw EV ' + pctText(sel.raw_ev) + ' on a market without validated skill.');
    else if (sel.off_market) cap('PRICE_ANOMALY', 'WATCH', sel.off_market);
    if (qb.unresolved_critical) cap('QB_UNRESOLVED', 'WATCH'); else if (qb.known === false) cap('QB_UNKNOWN', 'WATCH');
    if (av.major_uncertainty || av.pending) cap('AVAILABILITY_PENDING', 'WATCH');
    if (mq === 'THIN') cap('THIN_MARKET', 'LEAN');
    if (mk.max_class && mk.max_class !== 'BET') cap('MARKET_NOT_VALIDATED', mk.max_class);
    out.caps = caps;
    var cls = sel.price_cls, binding = null;
    caps.forEach(function (c) { if (CLASS_RANK[c.max] < CLASS_RANK[cls]) { cls = c.max; binding = c; } });
    out.reasons = [sel.ev > 0 ? 'POSITIVE_EV' : 'NEGATIVE_EV', sel.source === 'model_estimated' ? 'MODEL_ESTIMATED_PROBABILITY' : 'PARTIALLY_CALIBRATED_PROBABILITY'];
    var trig = null; try { trig = betTrigger(input, sel.o, cfg); } catch (e) { trig = null; }
    out.bet_trigger = trig;
    var xctxO = { cfg: cfg, L: L, canon: null, caps: caps, conf: conf, review: null, mq: mq, warnings: out.warnings, gSide: null, source: sel.source };
    function done(k, code) { attachExecution(out, input, sel, xctxO, k); return finish(out, k, code); }
    if (cls === 'BET') {
      var Z = sizing(input, sel, { cfg: cfg, confidence: conf, review: null, mq: mq, canon: null, league_cfg: L, warnings: out.warnings });
      out.sizing = Z;
      if (Z.units > 0) { out.recommended_units = Z.units; out.units = Z.units; out.tier = Z.tier; out.strength = Z.tier; out.strength_label = STRENGTH[Z.tier].label; attachQuote(out, input, sel, true); return done('BET', 'QUALIFIES'); }
      binding = { code: 'SIZING_ZERO', max: 'LEAN' }; cls = 'LEAN';
    }
    if (binding) { out.decision_qualifier = QUALIFIER[binding.code] || null; return done(cls, binding.code); }
    if (cls === 'LEAN') return done('LEAN', 'LEAN_EDGE');
    /* as for spreads: WATCH only when a realistic move would make it a BET */
    if (nearTrigger(trig, L)) { out.decision_qualifier = QUALIFIER.NEAR_THRESHOLD; return done('WATCH', 'NEAR_THRESHOLD'); }
    return done('PASS', sel.ev > 0 ? 'EDGE_TOO_SMALL' : 'NO_MODEL_EDGE');
  }
  /* ======================================================= MARKET STATE
     "What prices are actually available?" — from the SAME quotes this
     decision priced, so a game with a live priced quote can never read NO
     MARKET, and a stale or faulted market can never read LIVE. */
  var MARKET_FAULT_CHECKS = ['SAME_GAME', 'ORIENTATION', 'SPREAD_SIGN', 'CONSENSUS_AGREEMENT', 'LADDER_CONSISTENT', 'BOOK_AGREEMENT', 'NO_ARBITRAGE', 'MARKET_INTEGRITY'];
  var GAME_CLOSED = ['GAME_STARTED', 'GAME_CANCELLED', 'GAME_POSTPONED', 'GAME_SUSPENDED'];
  function rawQuotesFor(input, mt) {
    var raw = input.quotes || (input.evaluation && input.evaluation.sides ? quotesFromEvaluation(input.evaluation) : []);
    return (raw || []).filter(function (q) { if (!q) return false; var m = marketOf(q); return mt === 'spread' ? (m === 'spread' || m === 'alternate_spread') : m === mt; });
  }
  function rawFreshness(q, cfg, now) {
    if (q.fresh === true) return 'FRESH';
    if (q.fresh === false) return 'STALE';
    var st = upper(q.freshness_state);
    if (st === 'STALE' || st === 'STARTED') return 'STALE';
    if (st === 'CURRENT' || st === 'AGING' || st === 'FRESH') return 'FRESH';
    var at = ms(q.captured_at), n = ms(now);
    if (at == null || n == null) return 'UNKNOWN';
    return (n - at) / 60000 <= cfg.freshness.max_quote_age_minutes ? 'FRESH' : 'STALE';
  }
  function marketStateOf(d, input, cfg) {
    cfg = cfg || resolveConfig(null);
    var codes = (d && d.blocker_codes) || [], mt = (d && d.market_type) || 'spread', key, why;
    function has2(c) { return codes.indexOf(c) >= 0; }
    if (has2('NO_MARKET')) { key = 'NO_MARKET'; why = 'no sportsbook quote is on file for this market'; }
    else if (has2('MARKET_SUSPENDED')) { key = 'NO_MARKET'; why = 'the market is off the board (suspended)'; }
    else if (has2('STALE_QUOTE')) { key = 'STALE_MARKET'; why = 'every quote on file is older than the freshness limit'; }
    else if (has2('FRESHNESS_UNKNOWN')) { key = 'STALE_MARKET'; why = 'no quote carries a capture time, so none can be called current'; }
    else if (has2('CORRUPTED_ODDS') || has2('ORIENTATION_FAULT') || has2('NO_VALID_QUOTE')) { key = 'MARKET_FAULT'; why = d.action_reason_text; }
    else if (d && d.evaluation_status === 'EVALUABLE') {
      var A = d.anomaly, failing = A && A.triggered && A.checks ? A.checks.filter(function (c) { return c.status === 'FAIL' && MARKET_FAULT_CHECKS.indexOf(c.code) >= 0; }) : [];
      if (failing.length) { key = 'MARKET_FAULT'; why = 'the quote failed ' + failing.map(function (c) { return c.code.replace(/_/g, ' ').toLowerCase(); }).join(', '); }
      else if (d.market_quality === 'THIN') { key = 'THIN_MARKET'; why = 'only one side of this number is priced'; }
      else { key = 'LIVE_MARKET'; why = d.market_quality === 'ACCEPTABLE' ? 'a current two-sided quote at one book' : 'current two-sided quotes'; }
    } else if (codes.some(function (c) { return GAME_CLOSED.indexOf(c) >= 0; })) { key = 'NO_MARKET'; why = 'the pregame market is closed (' + codes.join(', ').replace(/_/g, ' ').toLowerCase() + ')'; }
    else {
      /* blocked before pricing for a model or identity reason: describe the quotes themselves */
      var raw = rawQuotesFor(input || {}, mt), now = input ? input.now : null;
      var fr = raw.map(function (q) { return rawFreshness(q, cfg, now); });
      if (!raw.length) { key = 'NO_MARKET'; why = 'no sportsbook quote is on file for this market'; }
      else if (fr.indexOf('FRESH') >= 0) { key = 'LIVE_MARKET'; why = 'current quotes exist; the decision could not price them (' + codes.join(', ').replace(/_/g, ' ').toLowerCase() + ')'; }
      else { key = 'STALE_MARKET'; why = 'no quote on file is inside the freshness limit'; }
    }
    var M = MARKET_STATES[key];
    return { key: key, label: M.label, tone: M.tone, means: M.means, reason: why || null, bettable: VOC.BETTABLE_MARKET_STATES.indexOf(key) >= 0 };
  }
  /* THE CANONICAL QUOTE: the exact quote the EV on this decision was computed
     from, in one shape every surface reads */
  function canonicalQuote(d) {
    if (!d) return null;
    var q = d.decision === 'BET' ? d.bet_price : (d.reference_quote || d.bet_price);
    if (!q) return null;
    var A = d.anomaly;
    var ver = q.last_known ? 'NOT_CURRENT' : (!A || !A.triggered ? 'NOT_REQUIRED' : (A.cleared ? 'VERIFIED' : 'FAILED'));
    var mt = q.market_type === 'alternate_spread' ? 'spread' : (q.market_type || d.market_type || 'spread');
    var team = q.team || (q.side === 'home' ? d.home : (q.side === 'away' ? d.away : null));
    var odds = isNum(num(q.odds)) ? num(q.odds) : null;
    return { event_id: d.game_id, market_type: mt, is_alternate: q.is_main_line === false, side: q.side || null, team: team || null,
      selection: pickText({ market_type: mt, side: q.side }, team || q.side, num(q.line)), line: num(q.line), odds: odds,
      label: q.label || null, sportsbook: q.book || null, captured_at: q.captured_at || null, age_minutes: isNum(q.quote_age_minutes) ? q.quote_age_minutes : null,
      freshness: q.last_known ? 'NOT_CURRENT' : (q.freshness || null), orientation: d.canonical && d.canonical.orientation ? d.canonical.orientation.status : (mt === 'spread' ? null : 'N/A'),
      verification_state: ver, quote_id: q.quote_id || null, source: 'EDQuoteEV.priceQuote · ' + (d.pricing_model_version || 'quote EV') + ' · ' + VERSION,
      raw_ev_pct: d.raw_ev_pct, calibrated_ev_pct: d.calibrated_ev_pct, decision_ev_pct: d.decision_ev_pct };
  }
  function withMarketState(d, input, cfg) {
    if (!d) return d;
    d.market_state = marketStateOf(d, input, cfg);
    d.quote = canonicalQuote(d);
    return d;
  }
  function marketSummary(d) {
    if (!d) return null;
    var q = d.bet_price || d.reference_quote;
    return { market_type: d.market_type, market_key: d.market_key, decision: d.decision, label: d.decision_label, display: d.decision_display, qualifier: d.decision_qualifier,
      market_state: d.market_state ? d.market_state.key : null,
      evaluation_status: d.evaluation_status, reason_code: d.action_reason_code, reason: d.action_reason_text, blocker_codes: d.blocker_codes.slice(),
      selection: q ? q.label : null, book: q ? q.book : null, units: d.recommended_units, probability_source: d.probability_source, edge_pp: d.edge_pp,
      raw_ev_pct: d.raw_ev_pct, decision_ev_pct: d.decision_ev_pct, decision_confidence: d.decision_confidence };
  }

  /* ============================================================ DECIDE */
  function resolveConfig(over) { return over && over.version === CONFIG_VERSION && Object.isFrozen && Object.isFrozen(over) ? over : config(over); }
  function decide(input, over) {
    /* a shallow copy: the working fields (_evaluation, _qctx) never touch the caller's object */
    input = assign({}, input || {});
    var cfg = resolveConfig(over);
    var mt = input.market_type || 'spread';
    if (mt === 'alternate_spread') mt = 'spread';
    if (mt !== 'spread' && mt !== 'total' && mt !== 'moneyline') { var u = skeleton(input, cfg, mt); return withMarketState(blocked(u, 'UNSUPPORTED_MARKET'), input, cfg); }
    var d = mt === 'spread' ? decideSpread(input, cfg) : decideOther(input, cfg, mt);
    /* a NO DECISION still describes the market it could not use (stale,
       single-sourced, off the board), from the same canonical object */
    if (!d.market && input.quotes && input.quotes.length) {
      var lastQ = d.reference_quote && d.reference_quote.last_known ? { side: d.reference_quote.side, team: d.reference_quote.team, line: d.reference_quote.line, american_odds: d.reference_quote.odds, sportsbook: d.reference_quote.book, captured_at: d.reference_quote.captured_at, is_main_line: true, quote_status: 'STALE' } : null;
      d.market = marketCanon(input, input.quotes.filter(function (q) { var m = q && marketOf(q); return mt === 'spread' ? (m === 'spread' || m === 'alternate_spread') : m === mt; }), lastQ, mt, leagueOf(input), null, null);
    }
    d = withMarketState(d, input, cfg);
    d.versions = versionsOf(input, d);
    d.data_snapshot_at = d.versions.data_snapshot_at;
    d.markets = {};
    d.markets[mt] = marketSummary(d);
    ['spread', 'total', 'moneyline'].forEach(function (m) {
      if (m === mt) return;
      if (m === 'spread' || !input.model) { d.markets[m] = null; return; }
      try { d.markets[m] = marketSummary(withMarketState(decideOther(assign({}, input), cfg, m), input, cfg)); }
      catch (e) { d.markets[m] = { market_type: m, decision: 'NO_DECISION', label: 'NO DECISION', reason_code: 'ENGINE_ERROR', reason: String(e && e.message || e).slice(0, 160), blocker_codes: ['ENGINE_ERROR'] }; }
    });
    return d;
  }
  /* the name this architecture is known by: one engine, league-configured */
  function footballDecisionEngine(input, over) { return decide(input, over); }

  /* ============================================================ TEXT */
  function selectionText(d) {
    if (!d) return null;
    var q = d.decision === 'BET' ? d.bet_price : (d.reference_quote || d.bet_price);
    return q ? q.label : null;
  }
  function actionLine(d) { return d ? d.decision_display || d.decision_label : ''; }
  function whyText(d) {
    if (!d) return '';
    if (d.decision === 'NO_DECISION') return d.action_reason_text;
    var C = d.canonical || {}, q = d.bet_price || d.reference_quote;
    var parts = [];
    var fav = favText(null, isNum(C.fair_home_spread) ? -C.fair_home_spread : null, d.home, d.away);
    if (fav && q && d.market_type === 'spread') {
      var inside = q && isNum(d.model_fair_line) ? q.line - d.model_fair_line : null;
      parts.push('Model makes ' + fav + (isNum(C.decision_fair_home_spread) ? ' (' + (d.probability_source === 'partially_calibrated' ? 'calibrated/blended ' : '') + favText(null, -C.decision_fair_home_spread, d.home, d.away) + ')' : '')
        + '; ' + q.label + (isNum(inside) ? (inside > 0.05 ? ' sits ' + inside.toFixed(1) + ' pts inside the model number' : (inside < -0.05 ? ' sits ' + Math.abs(inside).toFixed(1) + ' pts beyond the model number' : ' sits on the model number')) : '') + '.');
    }
    if (d.decision === 'BET') parts.push('The price passes EdgeDesk’s current thresholds (edge ' + ppText(d.edge_pp) + ', EV ' + pctText(d.decision_ev_pct / 100) + ' on a ' + String(d.probability_source_label || '').toLowerCase() + ' probability)' + (d.probability_source === 'calibrated' ? '.' : (d.probability_source === 'model_estimated' ? '; no calibration exists for this market yet, so the stake is capped.' : '; the calibration is validated out of sample, not yet on settled live results, so the stake is capped.')));
    else parts.push(d.action_reason_text);
    if (d.watch && d.watch.trigger && d.decision !== 'BET') parts.push(d.watch.trigger);
    else if (d.bet_trigger && d.bet_trigger.short && d.decision !== 'BET') parts.push('BET trigger: ' + d.bet_trigger.short + '.');
    return parts.join(' ');
  }
  /* the EV the decision used, named for what it is: CALIBRATED when a
     calibration exists, MODEL-ESTIMATED when none does. Raw EV beside a
     calibration is diagnostic only. */
  function evLabels(d) {
    var cal = isNum(d.calibrated_ev_pct);
    return { decision: cal ? VOC.EV_LABEL.calibrated : VOC.EV_LABEL.model_estimated, decision_ev_pct: cal ? d.calibrated_ev_pct : d.decision_ev_pct,
      raw: cal ? VOC.EV_LABEL.raw : null, raw_ev_pct: cal ? d.raw_ev_pct : null };
  }
  function actionBlock(d) {
    var q = d.decision === 'BET' ? d.bet_price : (d.reference_quote || d.bet_price);
    var lines = [];
    if (q && d.decision !== 'NO_DECISION') {
      var EL = evLabels(d);
      lines.push('Model cover: ' + probText(d.probability) + (d.probability_source && d.probability_source !== 'model_estimated' && isNum(d.cover_probability) ? ' (raw ' + probText(d.cover_probability) + ')' : ''));
      lines.push('Break-even: ' + probText(d.break_even));
      lines.push('Edge: ' + ppText(d.edge_pp));
      lines.push((EL.raw ? 'Calibrated EV' : 'Model-estimated EV') + ': ' + pctText(isNum(EL.decision_ev_pct) ? EL.decision_ev_pct / 100 : null) + ' (' + EL.decision.note.toLowerCase() + ')');
      if (EL.raw) lines.push('Raw model EV: ' + pctText(isNum(EL.raw_ev_pct) ? EL.raw_ev_pct / 100 : null) + ' (diagnostic only)');
      lines.push('Probability: ' + (d.probability_source_label || '—'));
      if (isNum(d.decision_confidence)) lines.push('Decision confidence: ' + d.decision_confidence + '/100 · ' + d.decision_confidence_label);
    }
    return { headline: d.decision_display || d.decision_label,
      selection: q ? q.label + (q.book ? ' · ' + q.book : '') : null,
      units: d.decision === 'BET' ? unitsText(d.recommended_units) : '0U',
      lines: lines,
      trigger: d.decision !== 'BET' ? (d.watch && d.watch.trigger ? d.watch.trigger : (d.bet_trigger && d.bet_trigger.short ? d.bet_trigger.short : null)) : null,
      blockers: d.blocker_codes ? d.blocker_codes.slice() : [] };
  }
  /* ONE SENTENCE: why this decision, in the words a new reader needs */
  function oneSentence(d) {
    if (!d) return '';
    var q = d.decision === 'BET' ? d.bet_price : (d.reference_quote || d.bet_price);
    var src = d.probability_source === 'calibrated' ? 'calibrated' : (d.probability_source === 'partially_calibrated' ? 'calibrated' : 'model-estimated');
    if (d.decision === 'BET') {
      var C = d.canonical || {}, fm = isNum(C.decision_fair_home_spread) ? -C.decision_fair_home_spread : (isNum(C.fair_home_spread) ? -C.fair_home_spread : null);
      var fav = d.market_type === 'spread' ? favText(null, fm, d.home, d.away) : null;
      return (fav ? 'EdgeDesk makes it ' + fav + '; at ' : 'At ') + (q ? q.label : 'this price') + ' the ' + src + ' edge is ' + ppText(d.edge_pp) + ' (EV ' + pctText(isNum(d.decision_ev_pct) ? d.decision_ev_pct / 100 : null) + '), which clears the betting threshold.';
    }
    if (d.decision === 'LEAN' && d.action_reason_code === 'LEAN_EDGE') return 'Positive ' + src + ' edge (' + ppText(d.edge_pp) + '), but below EdgeDesk’s betting threshold.';
    return d.action_reason_text || '';
  }
  /* the warnings a bettor must see before acting — never the boilerplate */
  var IMPORTANT_WARNINGS = ['QB_UNCONFIRMED', 'QB_CONTESTED', 'AVAILABILITY_UNCERTAIN', 'LARGE_RATING_DIVERGENCE', 'FCS_GAME', 'MODEL_MARKET_OUTLIER', 'ORIENTATION_REPAIRED', 'ANOMALY_CLEARED', 'SINGLE_BOOK', 'ALT_LINE_TAIL'];
  function importantWarnings(d) {
    var out = (d && d.warnings || []).filter(function (w) { return IMPORTANT_WARNINGS.indexOf(w.code) >= 0; });
    var ex = extremeEvNote(d);
    if (ex) out.unshift({ code: 'EXTREME_RAW_EV', text: ex });
    return out;
  }
  /* a huge raw EV is never hidden and never actionable: say why it is not */
  function extremeEvNote(d, cfg) {
    cfg = cfg || resolveConfig(null);
    if (!d || !isNum(d.raw_ev_pct) || d.raw_ev_pct < 100 * cfg.anomaly.raw_ev - 1e-6) return null;
    var raw = 'Raw model EV ' + pctText(d.raw_ev_pct / 100) + ' is not actionable';
    var A = d.anomaly;
    if (A && A.triggered && !A.cleared) return raw + ': the price has not passed market verification (' + (A.checks || []).filter(function (c) { return c.status === 'FAIL'; }).map(function (c) { return c.code.replace(/_/g, ' ').toLowerCase(); }).join(', ') + '). No BET until it does.';
    if (isNum(d.calibrated_ev_pct)) return raw + ': calibration discounts it to ' + pctText(d.calibrated_ev_pct / 100) + ', the value the decision uses' + (A && A.cleared ? '; the price passed verification and the stake is capped.' : '.');
    return raw + ' by itself: it triggered price verification' + (A && A.cleared ? ', which passed; the stake is capped.' : '.');
  }
  /* the audit record: every decision as reason codes (docs §16) */
  function auditRecord(d) {
    if (!d) return null;
    var q = d.bet_price || d.reference_quote;
    return { decision: d.decision, tier: d.tier, units: d.recommended_units, selectedQuote: q ? { side: q.side, team: q.team, line: q.line, odds: q.odds, book: q.book, captured_at: q.captured_at } : null,
      probability: d.probability, breakEven: d.break_even, edgePP: d.edge_pp, rawEV: isNum(d.raw_ev_pct) ? r(d.raw_ev_pct / 100, 4) : null,
      calibratedEV: isNum(d.calibrated_ev_pct) ? r(d.calibrated_ev_pct / 100, 4) : null, decisionConfidence: d.decision_confidence, probabilitySource: d.probability_source,
      evaluationStatus: d.evaluation_status, reasonCode: d.action_reason_code, reasons: (d.reasons || []).slice(), warnings: (d.warning_codes || []).slice(), blockers: (d.blocker_codes || []).slice(),
      caps: (d.caps || []).map(function (c) { return c.code; }), researchStatus: d.research_status };
  }
  /* one priced quote's own status (the per-quote classification; the
     recommendation's exact quote carries the game's decision) */
  function quoteStatus(d, o) {
    if (!d || !o) return { status: 'NO_DECISION', reason: 'no decision', evaluated: false };
    function at(x, line, odds, book) { return x && x.side === o.side && (isNum(line) && isNum(o.line) ? Math.abs(line - o.line) < EPS : line == null && o.line == null) && String(book || '').toLowerCase() === String(o.sportsbook || '').toLowerCase() && Math.round(num(odds)) === Math.round(num(o.american_odds)); }
    /* the engine's own verdict first: it priced these quotes itself, so a board
       that withholds EV (a guard it only suspects) still names the decision */
    var q = d.bet_price || d.reference_quote;
    if (q && at(q, q.line, q.odds, q.book)) return { status: d.decision, reason: d.action_reason_text, evaluated: true, source: 'decision engine' };
    if (d.decision === 'NO_DECISION') return { status: 'NO_DECISION', reason: d.action_reason_text, evaluated: false };
    var c = (d.candidates || []).filter(function (x) { return at(x, x.line, x.odds, x.book); })[0];
    if (!c && !o.ev_available) return { status: 'NO_DECISION', reason: 'EV unavailable · ' + o.ev_unavailable_reason, evaluated: false };
    if (!c) return { status: 'NOT_EVALUATED', reason: 'This quote is outside the decision’s candidate set.', evaluated: false };
    if (c.price_unverified) return { status: 'WATCH', reason: reasonText('PRICE_ANOMALY') + ' This exact quote failed price verification, so it is not offered; the recommendation is ' + (selectionText(d) || 'another quote') + '.', evaluated: true, source: 'decision engine (quote-level)' };
    var cls = c.classification;
    (d.caps || []).forEach(function (k) { if (k.code !== 'TAIL_UNVALIDATED' && CLASS_RANK[k.max] < CLASS_RANK[cls]) cls = k.max; });
    /* only the recommendation is sized: another qualifying quote says so, without a stake */
    if (cls === 'BET') cls = 'QUALIFIES';
    return { status: cls, reason:'Quote-level classification at this exact line and price (' + ppText(c.edge_pp) + ' edge, ' + pctText(c.decision_ev) + ' EV, ' + SOURCES[c.source].label.toLowerCase() + '); the recommendation is ' + (selectionText(d) || 'another quote') + '.', evaluated: true, source: 'decision engine (quote-level)' };
  }
  /* the verdict the quote-EV board prints beside its best price */
  function quoteDecisionOf(d) {
    if (!d) return null;
    var q = d.bet_price || d.reference_quote;
    return { status: d.decision, label: d.decision_display || d.decision_label, reason: d.action_reason_text,
      short: d.decision === 'NO_DECISION' ? (d.blocker_codes || []).map(function (c) { return c.replace(/_/g, ' ').toLowerCase(); }).join(', ') || null : null,
      requires: null, evaluated_quote: q ? { team: q.team, side: q.side, line: q.line, price: q.odds, book: q.book } : null, engine: VERSION, decision_id: d.decision_id };
  }

  return {
    VERSION: VERSION, CONFIG_VERSION: CONFIG_VERSION, UNVALIDATED: UNVALIDATED, DEFAULT_CONFIG: deepFreeze(copy(DEFAULT_CONFIG)),
    DECISIONS: deepFreeze(copy(DECISIONS)), DECISION_KEYS: DECISION_KEYS, CLASS_RANK: deepFreeze(copy(CLASS_RANK)), STRENGTH: deepFreeze(copy(STRENGTH)), SOURCES: deepFreeze(copy(SOURCES)),
    REASONS: deepFreeze(copy(REASONS)), QUALIFIER: deepFreeze(copy(QUALIFIER)), TOOLTIP: deepFreeze(copy(TOOLTIP)),
    INTEGRITY_FLAGS: INTEGRITY_FLAGS, MAGNITUDE_FLAGS: MAGNITUDE_FLAGS,
    config: config, decide: decide, footballDecisionEngine: footballDecisionEngine,
    /* parts, exposed for tests, the adapters and the page */
    normalizeQuotes: normalizeQuotes, quotesFromEvaluation: quotesFromEvaluation, blendAdjusted: blendAdjusted, sourceOfAdjusted: sourceOfAdjusted, modelSource: modelSource,
    metricsOf: metricsOf, priceClass: priceClass, canonicalOf: canonicalOf, priceReview: priceReview, decisionConfidence: decisionConfidence,
    playable: playable, betTrigger: betTrigger, sizing: sizing, marketQuality: marketQuality, stabilityOf: stabilityOf, twoSidedOf: twoSidedOf,
    quoteDispersion: quoteDispersion, mirrorFault: mirrorFault, riskAdjusted: riskAdjusted, returnSd: returnSd, quoteSummary: quoteSummary,
    reasonText: reasonText, actionLine: actionLine, selectionText: selectionText, oneSentence: oneSentence, whyText: whyText, actionBlock: actionBlock,
    evLabels: evLabels, importantWarnings: importantWarnings, extremeEvNote: extremeEvNote,
    marketStateOf: marketStateOf, canonicalQuote: canonicalQuote, bestPriceAt: bestPriceAt, MARKET_STATES: deepFreeze(copy(MARKET_STATES)), VOCAB: VOC,
    auditRecord: auditRecord, quoteStatus: quoteStatus, quoteDecisionOf: quoteDecisionOf,
    hypoClassifier: hypoClassifier, versionsOf: versionsOf, marketCanon: marketCanon,
    lineText: lineText, priceText: priceText, pctText: pctText, ppText: ppText, probText: probText, unitsText: unitsText, hash: hash
  };
}));

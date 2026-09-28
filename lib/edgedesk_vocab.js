/* ===========================================================================
   EDGEDESK VOCABULARY — one home for the words the product shows a reader.
   docs/bettor-decision/CONSISTENCY.md

   EdgeDesk answers a chain of questions, and every surface keeps them apart:

     RESEARCH    What deserves investigation?               research status
     MODEL       What does EdgeDesk make the game?          fair line, distribution
     MARKET      What prices are actually available?        market state
     PRICING     Does the current price have value?         edge, calibrated EV
     DECISION    BET / LEAN / WATCH / PASS / NO DECISION    decision status
     SIZING      If BET, how much exposure is justified?    units
     MONITORING  What change would alter the decision?      bet trigger, playable to
     GRADING     What happened versus the close?            CLV, observed vs expected

   The same state means the same thing everywhere. The engines keep their own
   internal enums (the v1 WAIT, the research canon's NO_MARKET key for a stale
   capture) where renaming them would force a storage migration; this file is
   where each one gets the ONE word a reader sees.

   Browser: window.EDVocab (load before lib/edgedesk_decision.js).
   Node: require('./edgedesk_vocab.js'). ES5, no dependencies.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDVocab = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_vocab_v1';

  function freeze(o) {
    if (o && typeof o === 'object' && !(o instanceof RegExp) && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { freeze(o[k]); }); }
    return o;
  }

  /* ------------------------------------------------ THE QUESTION CHAIN */
  var LAYERS = [
    { key: 'RESEARCH', question: 'What deserves investigation?' },
    { key: 'MODEL', question: 'What does EdgeDesk make the game?' },
    { key: 'MARKET', question: 'What prices are actually available?' },
    { key: 'PRICING', question: 'Does the current price have value after calibration?' },
    { key: 'DECISION', question: 'BET / LEAN / WATCH / PASS / NO DECISION' },
    { key: 'SIZING', question: 'If BET, how much exposure is justified?' },
    { key: 'MONITORING', question: 'What price or data change would alter the decision?' },
    { key: 'GRADING', question: 'What happened versus the close and the expected probability?' }
  ];

  /* ----------------------------------------------------- DECISION STATUS
     "Does the current available price justify action?" Only the decision
     engine (lib/edgedesk_decision.js) produces these. */
  var DECISION = {
    BET: { key: 'BET', label: 'BET', tone: 'bet', headline: 'Current price qualifies',
      short: 'The current verified price clears every decision gate.',
      means: 'This exact price clears EdgeDesk’s edge and calibrated expected-value thresholds with adequate market and model integrity. The stake is sized conservatively and capped by the probability source.' },
    LEAN: { key: 'LEAN', label: 'LEAN', tone: 'lean', headline: 'Positive edge, below the betting threshold',
      short: 'Positive edge, but below EdgeDesk’s betting threshold.',
      means: 'A pricing decision, not a directional opinion: the current price shows a positive edge on the model’s side of the market, but it does not clear the betting threshold. No stake. The BET trigger names the price that would.' },
    WATCH: { key: 'WATCH', label: 'WATCH', tone: 'watch', headline: 'Do not bet yet',
      short: 'Close enough that a realistic change in price or data could produce a BET.',
      means: 'EdgeDesk is waiting on something specific — a better price, a verification, a confirmed starter — and names it, with the BET trigger whenever one can be computed. Do not bet yet.' },
    PASS: { key: 'PASS', label: 'PASS', tone: 'pass', headline: 'Current price does not justify a wager',
      short: 'The current price does not justify action.',
      means: 'EdgeDesk evaluated this wager at the current price and it does not justify one. The reason is always named, and so is the BET trigger when a realistic one exists.' },
    NO_DECISION: { key: 'NO_DECISION', label: 'NO DECISION', tone: 'none', headline: 'Required information is missing or unusable',
      short: 'Required information does not exist or cannot be evaluated.',
      means: 'Essential market or model data is missing or invalid (no current quote, a stale or corrupted price, an unresolvable orientation, no model). The exact blocker is always named. It never means the model is young, calibration is accumulating, or EdgeDesk is being cautious.' }
  };
  var DECISION_KEYS = ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'];
  /* internal enums that read as one of the five words (v1 rows keep WAIT) */
  var DECISION_ALIAS = { WAIT: 'WATCH', NO_DECISION: 'NO_DECISION', 'NO DECISION': 'NO_DECISION' };
  function decisionKey(k) {
    if (k == null) return null;
    var s = String(k).toUpperCase().replace(/\s+/g, '_');
    if (DECISION[s]) return s;
    return DECISION_ALIAS[s] || DECISION_ALIAS[String(k).toUpperCase()] || null;
  }
  function decisionLabel(k) { var d = DECISION[decisionKey(k)]; return d ? d.label : (k == null ? '' : String(k).replace(/_/g, ' ')); }

  /* -------------------------------------------------------- MARKET STATE
     "What prices are actually available?" Derived from the SAME quotes the
     pricing used (lib/edgedesk_decision.js marketStateOf), never from a
     second join. */
  var MARKET_STATE = {
    LIVE_MARKET: { key: 'LIVE_MARKET', label: 'LIVE MARKET', tone: 'live',
      means: 'A current, usable sportsbook quote exists for this market.' },
    THIN_MARKET: { key: 'THIN_MARKET', label: 'THIN MARKET', tone: 'thin',
      means: 'A usable quote exists, but market confirmation is weak: only one side of this number is priced.' },
    STALE_MARKET: { key: 'STALE_MARKET', label: 'STALE MARKET', tone: 'stale',
      means: 'Quotes exist, but none is inside the freshness threshold. The last price is shown for reference; it is not a current price.' },
    NO_MARKET: { key: 'NO_MARKET', label: 'NO MARKET', tone: 'none',
      means: 'No usable current sportsbook quote exists for this market.' },
    MARKET_FAULT: { key: 'MARKET_FAULT', label: 'MARKET FAULT', tone: 'fault',
      means: 'Quotes exist but cannot be trusted: the orientation, the consensus, the price arithmetic, the ladder or the books contradict each other, or a validation check failed.' }
  };
  var MARKET_STATE_KEYS = ['LIVE_MARKET', 'THIN_MARKET', 'STALE_MARKET', 'NO_MARKET', 'MARKET_FAULT'];
  /* a market state that allows a BET at all (STALE / NO / FAULT never do) */
  var BETTABLE_MARKET_STATES = ['LIVE_MARKET'];

  /* ------------------------------------------------ EV, SAID TWO WAYS */
  var EV_LABEL = {
    raw: { label: 'RAW MODEL EV', note: 'Diagnostic only' },
    calibrated: { label: 'CALIBRATED EV', note: 'Used by the decision engine' },
    model_estimated: { label: 'MODEL-ESTIMATED EV', note: 'Used by the decision engine · no calibration exists yet' }
  };

  /* --------------------------------------------------------- HELP TEXT
     Short, one idea each. The decision engine exposes these as
     EDDecision.TOOLTIP; the pages show them on hover and on focus. */
  var HELP = {
    edge: 'Difference between EdgeDesk’s estimated cover probability and the break-even probability at this price.',
    calibrated_ev: 'Expected return after EdgeDesk adjusts the raw model probability using its current calibration layer. This is the value the decision engine uses.',
    raw_ev: 'Expected return from the unadjusted model probability. Diagnostic only: it never decides or sizes a wager.',
    model_estimated_ev: 'Expected return from the model probability when no calibration exists for this market yet. The decision uses it, labelled MODEL-ESTIMATED, with a smaller maximum stake.',
    decision_ev: 'The expected value the decision uses: calibrated when a calibration exists, otherwise the model-estimated value (never a raw number with a calibration beside it).',
    playable_to: 'The worst line and price EdgeDesk currently estimates still clears the BET threshold, holding the rest of the market where it is. EdgeDesk re-evaluates whenever the market moves.',
    decision_confidence: 'Confidence in the complete decision state, including the model, the market and the available information. It is not the probability that the bet wins.',
    reliability: 'How complete and stable the model inputs are for this game (0-100). It is not a betting recommendation and not a win probability.',
    probability_source: 'Where the decision probability comes from: CALIBRATED (live-validated), PARTIALLY CALIBRATED (out-of-sample calibration or a validated market blend) or MODEL-ESTIMATED (no calibration yet). Lower sources cap the stake.',
    unit: 'A standardized stake size. EdgeDesk defaults 1 unit to 1% of bankroll.',
    bet_trigger: 'The line or price at which this side would clear EdgeDesk’s betting threshold, holding the rest of the market where it is.',
    research_status: 'Research status answers “should I investigate this matchup?” It is never a wager recommendation.',
    bet_decision: 'Decision status answers “does the current available price justify action?” Only the decision engine sets it.',
    market_state: 'Market state answers “what prices are actually available?”: LIVE, THIN, STALE, NO MARKET or MARKET FAULT, from the same quotes the pricing used.',
    edge_strength: 'The stake tier: 0.25U, 0.50U, 0.75U or 1.00U, sized from the calibrated edge, EV and decision confidence, then capped by the probability source and every uncertainty. Raw EV never sizes.',
    unit_rule: 'Every stake tier is a conservative default until that tier has 50 settled BET decisions. A small sample never changes unit sizing automatically.',
    model_fair: 'EdgeDesk’s own fair line for this game. The sportsbook market never enters it.',
    best_current_price: 'The best price across the books on file for the exact line the decision evaluated.',
    best_playable_alternate: 'A nearby alternate line on the same side that also clears the BET threshold at an executable price.',
    safer_alternate: 'A nearby lower-variance line on the same side that still carries positive expected value.',
    best_available: 'The best price across the books on file for the exact line the decision evaluated. Extreme alternates never qualify.',
    best_value: 'The quote with the best risk-adjusted expected value (EV per unit of return volatility) among the executable lines and books.',
    safer_value: 'A nearby lower-variance line on the same side that still carries positive expected value.',
    best_price: 'The best sportsbook price for the selected exact line.',
    consensus: 'The number most books are dealing.',
    bet_price: 'The exact quote the decision was reached on: this line, this price, this book.',
    cover_probability: 'EdgeDesk’s probability that this side covers this exact line (pushes excluded). An estimate, not a guarantee.',
    market_quality: 'VERIFIED: two-sided and corroborated by several fresh books. STRONG: two-sided, several books. ACCEPTABLE: two-sided at one fresh book. THIN: only one side of the number is priced.',
    validation: 'Decision thresholds and stake tiers are conservative defaults. Live validation is in progress: they have not yet been validated on settled results.'
  };

  /* --------------------------------------------- STATUS TEXT, NOT "?" */
  var STATUS_LINE = {
    decision_rules: { label: 'Decision rules', value: 'Conservative defaults' },
    live_validation: { label: 'Live validation', value: 'In progress' },
    research_status: { label: 'Research status', value: 'Separate from the bet decision' },
    calibration: {
      calibrated: 'Calibrated',
      partially_calibrated: 'Partially calibrated',
      model_estimated: 'Model-estimated (no calibration yet)'
    }
  };

  /* ------------------------------------------------------ UNIT TIERS */
  var UNIT_RULE = {
    min_settled_bets: 50,
    current: 'Current conservative sizing rule',
    validated: 'Validated sizing rule',
    tiers: [0.25, 0.50, 0.75, 1.00],
    note: 'Each tier stays a conservative default until it has 50 settled BET decisions. A small sample never changes unit sizing automatically.'
  };
  function unitRuleOf(settled, validated) {
    var n = typeof settled === 'number' && isFinite(settled) ? settled : 0;
    var ok = validated === true && n >= UNIT_RULE.min_settled_bets;
    return { validated: ok, label: ok ? UNIT_RULE.validated : UNIT_RULE.current, settled: n, needed: UNIT_RULE.min_settled_bets,
      text: ok ? UNIT_RULE.validated : UNIT_RULE.current + ' · ' + Math.min(n, UNIT_RULE.min_settled_bets) + ' of ' + UNIT_RULE.min_settled_bets + ' settled bets' };
  }

  /* ------------------------------------------------------------- COPY */
  var COPY = {
    tagline: 'Sports market research and decision support.',
    product: 'EdgeDesk is a sports market research and decision-support platform. It evaluates model projections, live market prices, uncertainty and calibration to classify current prices as BET, LEAN, WATCH or PASS.',
    responsible: 'Research and decision-support tool. Signals can be wrong. 21+. Bet responsibly. 1-800-GAMBLER.',
    responsible_short: 'Signals can be wrong. 21+. Bet responsibly.',
    research_not_picks: 'Research, not picks.',
    do_not_bet_yet: 'DO NOT BET YET',
    no_realistic_trigger: 'NO REALISTIC BET TRIGGER AT CURRENT MODEL STATE',
    reevaluates: 'EdgeDesk automatically reevaluates the game when the market or the information changes.',
    research_vs_decision: 'Research status says whether a matchup deserves investigation. The decision says whether the current price justifies action. A game can be worth researching and still be a PASS.',
    top_research_title: 'TOP RESEARCH PRIORITIES',
    top_research_sub: 'Games most worth opening based on model-market disagreement, reliability, market quality, completeness and independent flags. This is not a ranking of bets.',
    no_settled_bets_title: 'NO SETTLED BETS YET',
    no_settled_bets: 'EdgeDesk will populate decision performance after published BET decisions settle. Unit tiers remain conservative defaults until each tier reaches the required validation sample.'
  };

  /* words a card must never use about a wager */
  var BANNED = /\b(lock|max lock|free money|can'?t miss|mortgage|guarantee[ds]?|safe bet|this will win|best bet|bet now|smash|hammer)\b/i;

  return freeze({
    VERSION: VERSION, LAYERS: LAYERS,
    DECISION: DECISION, DECISION_KEYS: DECISION_KEYS, DECISION_ALIAS: DECISION_ALIAS,
    MARKET_STATE: MARKET_STATE, MARKET_STATE_KEYS: MARKET_STATE_KEYS, BETTABLE_MARKET_STATES: BETTABLE_MARKET_STATES,
    EV_LABEL: EV_LABEL, HELP: HELP, STATUS_LINE: STATUS_LINE, UNIT_RULE: UNIT_RULE, COPY: COPY, BANNED: BANNED,
    decisionKey: decisionKey, decisionLabel: decisionLabel, unitRuleOf: unitRuleOf
  });
}));

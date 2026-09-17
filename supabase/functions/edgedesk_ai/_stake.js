// deno-lint-ignore-file
/*__EDSTAKE_START__*/
/* ===========================================================================
   EdgeDesk STAKING KERNEL — the best bet, and how much of a unit it is worth.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHAT IT ANSWERS
     "What are the best bets today?", "What's the best bet in this game?",
     "Is the spread, moneyline or total better?", "How many units?",
     "Build my card", "What's most mispriced?", "Over or under?" — every
     question whose honest answer is a NUMBER OF UNITS rather than a paragraph.

   WHAT IT IS NOT
     It is not a model and it is not a pricer. It computes no probability of
     its own. Every probability, every fair price and every line comes from
     EDINTEL (the de-vig fair, freshness, push-aware EV, the validation gate)
     or EDPRICE (the validated blend, the cover curve, the tier). This kernel
     turns those into a position size under a written risk policy, and refuses
     when they do not exist.

   WHAT IT DOES, IN ORDER
     1. SETTINGS. The reader's bankroll policy, normalised, every field with
        its source (stored or default). A base unit has a default ($25); a
        BANKROLL DOES NOT. An unknown bankroll costs the dollar figure, never
        the unit figure, and the answer says which.
     2. MARKET PROBABILITY. The no-vig probability of the selection, from both
        sides of the SAME market, and the disagreement across books. A
        vig-inflated price is never compared against a model number.
     3. RELIABILITY. A score in [0.05, 0.95] from eight named, weighted
        components — the calibration record for that sport and market, the
        effective sample behind it, data completeness, price freshness, book
        agreement, availability certainty, distribution stability and the
        model version's validation status. Every component is stored with the
        recommendation; none of it is narrative confidence.
     4. CONSERVATIVE PROBABILITY. An empirical lower bound where one exists
        (the fair line's own standard error through the cover curve), and
        otherwise a shrink toward 50% by the reliability score. STAKING USES
        THIS NUMBER AND NOTHING ELSE.
     5. EXPECTED VALUE at the exact executable price: EV = p*d - 1 with the
        conservative probability, plus the model and conservative edges
        against the no-vig market probability and the fair odds.
     6. UNITS. Full Kelly, then the configured fraction, then every cap (max
        single, game, team, daily, weekly, tier, reliability), then ROUNDED
        DOWN to a permitted quarter unit. Below 0.25u is 0u.
     7. GATES. Fourteen named conditions, any one of which returns PASS or
        RESEARCH ONLY. PASS IS A SUCCESSFUL ANSWER.
     8. THE CARD. One PRIMARY market per game, a second only when it
        independently qualifies and the game cap still holds; the portfolio
        rules over the whole slate (duplicate teams, duplicate selections,
        opposing positions, correlated game script); the exposure after every
        proposed wager.
     9. THE PARLAY, separately, under its own policy, and never with a
        multiplied probability.

   THE RULES
     - PASS is a result, not a failure. Nothing is ever forced.
     - Conviction is acknowledged and changes no number. Rivalry, revenge,
       atmosphere, rankings and narrative are not inputs.
     - No stake is produced from a raw edge, from a line difference, or from
       any probability this kernel could not name the source of.
     - Every size is rounded DOWN. The cap is a ceiling, never a target.
     - "MAX MODEL POSITION" means the largest size THIS POLICY allows. It is
       not a statement about certainty and the copy says so.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDSTAKE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_stake_recommendation_v1';
  var CARD_SCHEMA = 'edgedesk_stake_card_v1';
  var POLICY_SCHEMA = 'edgedesk_bankroll_policy_v1';
  var RECORD_SCHEMA = 'edgedesk_stake_record_v1';
  var PARLAY_SCHEMA = 'edgedesk_stake_parlay_v1';

  /* ==================================================================== */
  /* THE DEFAULT RISK POLICY                                              */
  /*                                                                      */
  /* Conservative on purpose, configurable on purpose, and printed with    */
  /* every answer so the reader argues with a number rather than a mood.   */
  /* ==================================================================== */
  var DEFAULT_POLICY = {
    /* No bankroll default. A bankroll nobody typed in is not a bankroll. */
    bankroll_amount: null,
    /* The base unit DOES have a default, because a unit is a unit whether or
       not the bankroll behind it has been recorded. */
    base_unit_amount: 25,
    maximum_single_wager_units: 1,
    maximum_game_exposure_units: 1.25,
    maximum_team_exposure_units: 1.5,
    maximum_daily_exposure_units: 4,
    maximum_weekly_exposure_units: 8,
    fractional_kelly_multiplier: 0.25,
    /* What one unit is, as a share of bankroll, when the bankroll itself is
       unknown. This is the standard definition of a unit (1%), it is stated
       in every answer that uses it, and it is NOT an assumed bankroll: it
       converts a Kelly FRACTION into UNITS without claiming a dollar figure.
       When both bankroll and base unit are known the real ratio replaces it. */
    unit_fraction_of_bankroll: 0.01,
    allowed_unit_sizes: [0, 0.25, 0.5, 0.75, 1],
    minimum_unit_size: 0.25,
    /* The parlay policy. Off unless the reader asks or enables it. */
    parlays_allowed: false,
    minimum_parlay_stake_units: 0.1,
    maximum_parlay_stake_units: 0.25,
    maximum_parlay_legs: 3,
    /* At most two positions may involve the same team, whatever the caps say. */
    maximum_positions_per_team: 2,
    /* A second market on the same game is allowed only when it qualifies on
       its own and the game cap still holds. */
    allow_second_market_per_game: true,
    preferred_sports: null,
    sportsbooks: null,
    /* The floors a wager must clear before any size is produced. */
    minimum_data_completeness: 0.5,
    minimum_reliability: 0.35,
    minimum_book_families: 2,
    /* Every cap above is a number of units; this is a probability. */
    minimum_conservative_ev: 0,
    /* The unit ceiling a validation tier permits, however good the arithmetic
       looks. A RESEARCH tier cannot produce a stake at all. */
    tier_unit_cap: { VALIDATED: 1, LEAN: 0.5, PROBABILITY: 0.25, RESEARCH: 0, MARKET_DEVIG: 0.75 },
    /* The unit ceiling the reliability score permits. Ordered, first match. */
    reliability_unit_cap: [
      { below: 0.35, units: 0 },
      { below: 0.5, units: 0.25 },
      { below: 0.65, units: 0.5 },
      { below: 0.8, units: 0.75 },
      { below: null, units: 1 }
    ]
  };

  var TIERS = [
    { tier: 'PASS', units: 0, label: 'PASS — 0u' },
    { tier: 'SMALL', units: 0.25, label: 'SMALL — 0.25u' },
    { tier: 'STANDARD', units: 0.5, label: 'STANDARD — 0.50u' },
    { tier: 'STRONG', units: 0.75, label: 'STRONG — 0.75u' },
    { tier: 'MAX MODEL POSITION', units: 1, label: 'MAX MODEL POSITION — 1.00u' }
  ];
  var STATUSES = ['BET', 'WATCH', 'PASS', 'RESEARCH_ONLY'];
  /* How many PASS and RESEARCH_ONLY rows a card carries and records. Every
     market evaluated is counted in `markets_evaluated`; these are the ones
     kept in full, ordered by expected value. */
  var PASS_LIMIT = 24;

  /* The gates, named once, in the order they are tested. A gate that fires
     names its own status: RESEARCH_ONLY when EdgeDesk cannot price the thing
     at all, PASS when it priced it and the answer is no. */
  var GATES = [
    { code: 'MARKET_OUT_OF_SCOPE', status: 'RESEARCH_ONLY', why: 'the market is outside the scope EdgeDesk models' },
    { code: 'MARKET_DEFINITION_MISMATCH', status: 'RESEARCH_ONLY', why: 'the quoted number is not the number the fair price was computed for' },
    { code: 'NO_EXECUTABLE_QUOTE', status: 'RESEARCH_ONLY', why: 'no executable sportsbook price is on file' },
    { code: 'ODDS_UNVERIFIED', status: 'RESEARCH_ONLY', why: 'the price could not be verified against a captured quote' },
    { code: 'STALE_PRICE', status: 'RESEARCH_ONLY', why: 'the captured price is outside its freshness limit' },
    { code: 'THIN_MARKET', status: 'RESEARCH_ONLY', why: 'too few independent books stand behind this number' },
    { code: 'MARKET_IN_SHADOW_MODE', status: 'RESEARCH_ONLY', why: 'the staking validation keeps this market in SHADOW or RESEARCH ONLY: it is sized and recorded, and it is not recommended' },
    { code: 'NO_CALIBRATION', status: 'RESEARCH_ONLY', why: 'no calibration record exists for this sport and market' },
    { code: 'MODEL_VERSION_UNVALIDATED', status: 'RESEARCH_ONLY', why: 'the model version behind this probability is not validated for betting' },
    { code: 'DATA_COMPLETENESS_BELOW_FLOOR', status: 'RESEARCH_ONLY', why: 'the inputs are too incomplete to size a position' },
    { code: 'CRITICAL_AVAILABILITY_UNRESOLVED', status: 'RESEARCH_ONLY', why: 'a starter, quarterback, pitcher or lineup question that moves this number is unresolved' },
    { code: 'FABRICATED_OR_INFERRED_DATA', status: 'RESEARCH_ONLY', why: 'a required input was inferred rather than observed' },
    /* WATCH, not PASS: the value is real and the refusal is about EdgeDesk's
       own confidence, so better data makes this a bet and it is worth
       carrying with a threshold rather than discarding. */
    { code: 'RELIABILITY_BELOW_FLOOR', status: 'WATCH', why: 'the reliability score is below the floor this policy stakes on' },
    { code: 'CONSERVATIVE_EV_NOT_POSITIVE', status: 'PASS', why: 'the conservative expected value at the executable price is not positive' },
    { code: 'LINE_MOVED_PAST_PLAYABLE', status: 'PASS', why: 'the number has moved past the point at which EdgeDesk would take it' },
    { code: 'EXPOSURE_CAP', status: 'PASS', why: 'the position would breach an exposure cap' },
    /* WATCH for the same reason: a better price raises the size over the floor. */
    { code: 'BELOW_MINIMUM_UNIT', status: 'WATCH', why: 'the sized position rounds down below the minimum permitted unit' }
  ];
  var GATE_BY_CODE = {}, GATE_ORDER = {};
  GATES.forEach(function (g, i) { GATE_BY_CODE[g.code] = g; GATE_ORDER[g.code] = i; });
  function gateIndex(code) { return GATE_ORDER[code] != null ? GATE_ORDER[code] : 999; }

  /* Markets this kernel may size. A team total or a player prop is sizeable
     only when a SEPARATELY VALIDATED model for it is registered; absent that
     registration the market is declared out of scope rather than approximated
     from the game line. */
  var SIZEABLE_MARKETS = { spreads: true, totals: true, h2h: true };
  var CONDITIONAL_MARKETS = { team_totals: 'team total', player_props: 'player prop' };
  /**
   * A team total or a player prop becomes sizeable ONLY when a separately
   * validated model for it is registered here, by sport and market. The
   * registration is the mechanism, not a courtesy: there is no path that
   * approximates a prop from a game line, and a market with no entry is
   * declared out of scope rather than estimated.
   *
   * `record` must carry a tier and a basis naming what it was validated on —
   * the same rule EDINTEL applies to a distribution, for the same reason: an
   * undocumented validation is indistinguishable from none in the output.
   */
  var VALIDATED_EXTRA_MARKETS = {};
  function registerValidatedMarket(sport, market, record) {
    if (!sport || !market) return { ok: false, why: 'a sport and a market are required' };
    if (!record || !record.tier || !record.basis) return { ok: false, why: 'a validated extra market must carry a tier and a basis naming what it was validated on; it is refused without them' };
    if (['VALIDATED', 'LEAN', 'PROBABILITY'].indexOf(String(record.tier)) < 0) return { ok: false, why: 'only a VALIDATED, LEAN or PROBABILITY tier can open a market for staking; got ' + record.tier };
    VALIDATED_EXTRA_MARKETS[sport + '|' + normMarket(market)] = record;
    return { ok: true, key: sport + '|' + normMarket(market), record: record };
  }
  function validatedExtraMarket(sport, market) { return VALIDATED_EXTRA_MARKETS[sport + '|' + normMarket(market)] || null; }
  function clearValidatedMarkets() { VALIDATED_EXTRA_MARKETS = {}; }

  /* ==================================================================== */
  /* THE STAKING VALIDATION REGISTRY                                      */
  /*                                                                      */
  /* football/validation/staking_<sport>.json says, per market, whether   */
  /* the sizing engine earned the right to recommend: BET where it beat   */
  /* BOTH flat baselines out of sample with a usable sample, SHADOW where */
  /* it sized and did not, RESEARCH_ONLY where it could not size at all.  */
  /*                                                                      */
  /* ABSENCE OF A RECORD IS NOT A BLOCK. A deployment with no artifact    */
  /* keeps the behaviour the tier caps already impose, because turning    */
  /* every market off on a missing file would be a silent outage dressed  */
  /* up as caution. A REGISTERED SHADOW, by contrast, is a decision, and  */
  /* it is obeyed. It governs the MODEL_BLEND path only: a market-de-vig  */
  /* price is not what this file graded, and its record is the CLV ledger. */
  /* ==================================================================== */
  var STAKING_VALIDATION = {};
  function loadStakingValidation(sport, json) {
    if (!sport || !json || !json.markets) return false;
    STAKING_VALIDATION[sport] = json; return true;
  }
  function stakingModeFor(sport, market) {
    var v = STAKING_VALIDATION[sport];
    var key = normMarket(market) === 'totals' ? 'total' : normMarket(market) === 'h2h' ? 'moneyline' : 'spread';
    var m = v && v.markets ? v.markets[key] : null;
    if (!m) return { mode: 'UNREGISTERED', basis: 'no staking validation is loaded for ' + (sport || 'this sport') + ' ' + key + '; the validation tier and the unit caps govern on their own', loaded: false, generated_at: null };
    return { mode: str(m.mode || 'SHADOW'), basis: str(m.mode_basis || ''), positions: num(m.positions), loaded: true, generated_at: v.generated_at || null, market: key };
  }
  function clearStakingValidation() { STAKING_VALIDATION = {}; }

  var FRESH_OK = { CURRENT: true, AGING: true, LIVE: true, RECENT: true };
  var FRESH_WEIGHT = { CURRENT: 1, LIVE: 1, AGING: 0.7, RECENT: 0.7, STALE: 0.15, UNKNOWN: 0.05, LINE_ONLY: 0.05, STARTED: 0 };
  var TIER_RELIABILITY = {
    VALIDATED: 1, LEAN: 0.7, PROBABILITY: 0.5, RESEARCH: 0.25, UNVALIDATED: 0.1,
    /* A de-vigged market reference is not a model and has no per-market
       calibration record: its only record is the CLV ledger, and EdgeDesk's
       is not yet established. So it scores as low as an unvalidated model on
       THIS component — deliberately, and stated here rather than reached by
       falling through a lookup. It is still the component that most often
       holds a line-shop edge to a small size, which is the intended
       behaviour: the edge is in the price and the price is all it is. */
    MARKET_DEVIG: 0.1
  };
  var AVAIL_CERTAINTY = { OFFICIAL_REPORT: 1, CONFIRMED: 1, REPORTED: 0.8, PROJECTED: 0.6, PARTIAL: 0.5, UNKNOWN: 0.3, UNRESOLVED: 0, STALE: 0.25 };

  /* The reliability weights. They sum to 1 and the kernel asserts it. */
  var RELIABILITY_WEIGHTS = [
    { name: 'calibration_record', weight: 0.22, basis: 'the validation tier recorded for this sport and market' },
    { name: 'effective_sample', weight: 0.15, basis: 'n / (n + 500): the graded sample behind that tier against EdgeDesk’s own validation floor' },
    { name: 'data_completeness', weight: 0.15, basis: 'the share of the inputs the projection wanted that were on file' },
    { name: 'price_freshness', weight: 0.15, basis: 'the captured quote’s state on the kickoff freshness ladder' },
    { name: 'book_agreement', weight: 0.12, basis: 'independent book families behind the number, against the minimum this policy wants' },
    { name: 'availability_certainty', weight: 0.11, basis: 'how far the starter, lineup and injury picture is observed rather than projected' },
    { name: 'distribution_stability', weight: 0.05, basis: 'whether the residual distribution used for the probability is the validated one or a default' },
    { name: 'model_validation_status', weight: 0.05, basis: 'whether the model version behind the probability carries a validation record' }
  ];

  /* ------------------------------------------------------------- helpers */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function r2(v) { var n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
  function r4(v) { var n = num(v); return n == null ? null : Math.round(n * 10000) / 10000; }
  function r6(v) { var n = num(v); return n == null ? null : Math.round(n * 1000000) / 1000000; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; var t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function uniq(a) { var s = {}, o = []; (a || []).forEach(function (x) { var k = String(x); if (x != null && !s[k]) { s[k] = 1; o.push(x); } }); return o; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function I() { return root.EDINTEL || null; }
  function P() { return root.EDPRICE || null; }
  function B() { return root.EDBOARD || null; }
  function R() { return root.EDRESEARCH || null; }
  function amToDec(am) { var a = num(am); if (a == null || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function decToAm(dec) { var d = num(dec); if (d == null || d <= 1) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function fmtAm(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : '') + Math.round(n); }
  function fmtLine(v) { var n = num(v); if (n == null) return ''; return (n > 0 ? '+' : '') + n; }
  function fmtUnits(v) { var n = num(v); return n == null ? '—' : n.toFixed(2) + 'u'; }
  function fmtMoney(v) { var n = num(v); return n == null ? null : '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ''); }
  function pct(v, d) { var n = num(v); return n == null ? '—' : (n * 100).toFixed(d == null ? 1 : d) + '%'; }
  function pp(v, d) { var n = num(v); return n == null ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(d == null ? 1 : d) + '%'; }
  function fnv1a(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function normName(s) { var Ik = I(); if (Ik && typeof Ik.normName === 'function') return Ik.normName(s); return str(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function normMarket(m) { var Ik = I(); if (Ik && typeof Ik.normMarket === 'function') return Ik.normMarket(m); var s = str(m).toLowerCase(); return s === 'spread' ? 'spreads' : s === 'total' ? 'totals' : (s === 'moneyline' || s === 'ml') ? 'h2h' : s; }
  function marketWord(m) { var k = normMarket(m); return k === 'spreads' ? 'spread' : k === 'totals' ? 'total' : k === 'h2h' ? 'moneyline' : str(m); }
  function localDate(ms, tz) { var Bk = B(); if (Bk && typeof Bk.localDate === 'function' && tz) { try { return Bk.localDate(ms, tz); } catch (_) { /* fall through */ } } var t = toMs(ms); return t == null ? null : new Date(t).toISOString().slice(0, 10); }
  /** The Monday-anchored week key of an instant in the reader's zone. */
  function weekKey(ms, tz) {
    var d = localDate(ms, tz); if (!d) return null;
    var t = Date.parse(d + 'T00:00:00Z'); if (!Number.isFinite(t)) return null;
    var dow = new Date(t).getUTCDay(); var back = (dow + 6) % 7; /* Monday = 0 */
    return new Date(t - back * 86400000).toISOString().slice(0, 10);
  }

  /* ==================================================================== */
  /* 1. SETTINGS                                                          */
  /* ==================================================================== */
  /**
   * Normalise the reader's bankroll settings.
   *
   * `raw` is one row of public.bankroll_settings, or null. Every field comes
   * back with its SOURCE, because "your $25 unit" and "the default $25 unit"
   * are different sentences and a reader is owed the right one.
   */
  function settings(raw, o) {
    o = o || {};
    var over = o.policy || {};
    var out = { schema: POLICY_SCHEMA, version: VERSION, sources: {}, warnings: [] };
    var row = raw && typeof raw === 'object' ? raw : null;
    function take(key, validate) {
      var v = row ? row[key] : undefined;
      var n = validate ? validate(v) : num(v);
      if (n != null) { out[key] = n; out.sources[key] = 'stored'; return; }
      var d = over[key] !== undefined ? over[key] : DEFAULT_POLICY[key];
      out[key] = d; out.sources[key] = over[key] !== undefined ? 'deployment' : 'default';
    }
    var positive = function (v) { var n = num(v); return n != null && n > 0 ? n : null; };
    var nonNeg = function (v) { var n = num(v); return n != null && n >= 0 ? n : null; };
    var fraction = function (v) { var n = num(v); return n != null && n > 0 && n <= 1 ? n : null; };
    take('bankroll_amount', positive);
    take('base_unit_amount', positive);
    take('maximum_single_wager_units', positive);
    take('maximum_game_exposure_units', positive);
    take('maximum_team_exposure_units', positive);
    take('maximum_daily_exposure_units', positive);
    take('maximum_weekly_exposure_units', positive);
    take('fractional_kelly_multiplier', fraction);
    take('minimum_parlay_stake_units', positive);
    take('maximum_parlay_stake_units', positive);
    take('maximum_parlay_legs', positive);
    take('maximum_positions_per_team', positive);
    take('minimum_data_completeness', nonNeg);
    take('minimum_reliability', nonNeg);
    take('minimum_book_families', nonNeg);
    take('minimum_conservative_ev', nonNeg);
    take('minimum_unit_size', positive);
    /* booleans and lists, kept separate: a false is not a missing value */
    out.parlays_allowed = row && typeof row.parlay_permission === 'boolean' ? row.parlay_permission
      : row && typeof row.parlays_allowed === 'boolean' ? row.parlays_allowed
        : (over.parlays_allowed !== undefined ? over.parlays_allowed : DEFAULT_POLICY.parlays_allowed);
    out.sources.parlays_allowed = row && (typeof row.parlay_permission === 'boolean' || typeof row.parlays_allowed === 'boolean') ? 'stored' : 'default';
    out.allow_second_market_per_game = row && typeof row.allow_second_market_per_game === 'boolean' ? row.allow_second_market_per_game : DEFAULT_POLICY.allow_second_market_per_game;
    out.preferred_sports = Array.isArray(row && row.preferred_sports) && row.preferred_sports.length ? row.preferred_sports.map(function (s) { return str(s).slice(0, 40); }).slice(0, 16) : null;
    out.sources.preferred_sports = out.preferred_sports ? 'stored' : 'default';
    out.sportsbooks = Array.isArray(row && row.sportsbook_availability) && row.sportsbook_availability.length ? row.sportsbook_availability.map(function (s) { return str(s).toLowerCase().slice(0, 40); }).slice(0, 32)
      : Array.isArray(row && row.sportsbooks) && row.sportsbooks.length ? row.sportsbooks.map(function (s) { return str(s).toLowerCase().slice(0, 40); }).slice(0, 32) : null;
    out.sources.sportsbooks = out.sportsbooks ? 'stored' : 'default';
    out.allowed_unit_sizes = (Array.isArray(row && row.allowed_unit_sizes) && row.allowed_unit_sizes.length
      ? row.allowed_unit_sizes.map(num).filter(function (n) { return n != null && n >= 0; })
      : (over.allowed_unit_sizes || DEFAULT_POLICY.allowed_unit_sizes)).slice().sort(function (a, b) { return a - b; });
    out.sources.allowed_unit_sizes = Array.isArray(row && row.allowed_unit_sizes) && row.allowed_unit_sizes.length ? 'stored' : 'default';
    out.tier_unit_cap = Object.assign({}, DEFAULT_POLICY.tier_unit_cap, over.tier_unit_cap || {}, (row && row.tier_unit_cap) || {});
    out.reliability_unit_cap = over.reliability_unit_cap || DEFAULT_POLICY.reliability_unit_cap;
    out.updated_at = row && row.updated_at ? iso(row.updated_at) : null;
    /* the unit, as a share of bankroll: the real ratio when both are known */
    if (out.bankroll_amount != null && out.base_unit_amount != null) {
      out.unit_fraction_of_bankroll = r6(out.base_unit_amount / out.bankroll_amount);
      out.sources.unit_fraction_of_bankroll = 'derived from the stored bankroll and base unit';
    } else {
      out.unit_fraction_of_bankroll = over.unit_fraction_of_bankroll !== undefined ? over.unit_fraction_of_bankroll : DEFAULT_POLICY.unit_fraction_of_bankroll;
      out.sources.unit_fraction_of_bankroll = 'policy default: one unit is ' + ((out.unit_fraction_of_bankroll) * 100) + '% of bankroll. This converts a Kelly fraction into units; it is not an assumed bankroll.';
    }
    /* the caps must be internally coherent: a single cannot exceed the game cap */
    if (out.maximum_single_wager_units > out.maximum_game_exposure_units) { out.warnings.push('maximum_single_wager_units (' + out.maximum_single_wager_units + ') exceeds maximum_game_exposure_units (' + out.maximum_game_exposure_units + '); the game cap governs.'); }
    out.bankroll_known = out.bankroll_amount != null;
    /* dollars are EXACT when the base unit was typed in, or when the bankroll
       is on file to anchor the default. Otherwise the answer is in units. */
    out.dollars_exact = out.sources.base_unit_amount === 'stored' || out.bankroll_known;
    out.dollars_note = out.dollars_exact
      ? (out.bankroll_known ? 'Dollar figures use your stored bankroll of ' + fmtMoney(out.bankroll_amount) + ' and base unit of ' + fmtMoney(out.base_unit_amount) + '.' : 'Dollar figures use your stored base unit of ' + fmtMoney(out.base_unit_amount) + '. Kelly is expressed in units because no bankroll amount is stored.')
      : 'No bankroll amount is stored, so the recommendation is in UNITS. An exact dollar amount needs bankroll_amount (and a base unit) in your settings; EdgeDesk will not assume one.';
    if (!out.bankroll_known) out.warnings.push('NO_BANKROLL_ON_FILE: units are sized from the Kelly fraction under the stated one-unit-is-' + (out.unit_fraction_of_bankroll * 100) + '%-of-bankroll convention. No bankroll amount was assumed.');
    out.basis = 'EdgeDesk default risk policy: ' + out.fractional_kelly_multiplier + ' Kelly, sizes of ' + out.allowed_unit_sizes.join('u / ') + 'u, at most ' + out.maximum_single_wager_units + 'u on a single, ' + out.maximum_game_exposure_units + 'u on one game, ' + out.maximum_team_exposure_units + 'u involving one team, ' + out.maximum_daily_exposure_units + 'u in a day and ' + out.maximum_weekly_exposure_units + 'u in a week.';
    return out;
  }

  /* ==================================================================== */
  /* 2. MARKET PROBABILITY                                                */
  /* ==================================================================== */
  /** Is this quote tradable at all? A malformed, suspended or undated quote is not. */
  function quoteCheck(q, o) {
    o = o || {};
    var problems = [];
    if (!q || typeof q !== 'object') return { ok: false, problems: ['no quote object'], executable: false };
    var dec = num(q.odds_decimal) != null ? num(q.odds_decimal) : amToDec(q.odds_american);
    if (q.suspended === true || /suspend|unavailable|off the board|taken down/i.test(str(q.status))) problems.push('the book has this market suspended or off the board');
    if (dec == null || dec <= 1) problems.push('no usable price');
    if (dec != null && dec > 1000) problems.push('a price of ' + dec + ' decimal is malformed for a two-way market');
    if (!q.book) problems.push('no book is recorded, so the price cannot be executed or verified');
    if (!q.captured_at) problems.push('no capture time, so the age of the price cannot be established');
    var fresh = str(q.freshness || 'UNKNOWN').toUpperCase();
    if (!FRESH_OK[fresh]) problems.push('the capture is ' + fresh + ' on the kickoff freshness ladder');
    return { ok: problems.length === 0, problems: problems, decimal: r4(dec), american: dec != null ? decToAm(dec) : null, freshness: fresh, executable: q.executable !== false && dec != null && !!q.book };
  }

  /**
   * The no-vig probability of the selection, from BOTH SIDES OF THE SAME
   * MARKET, plus the disagreement across books.
   *
   * Refuses rather than guesses: one side of a market cannot be de-vigged,
   * and the break-even at a single offered price is a vig-INFLATED number
   * that must never be handed to an edge calculation.
   */
  function noVig(o) {
    o = o || {};
    var Ik = I();
    var a = num(o.selection_american), b = num(o.opposite_american);
    var da = num(o.selection_decimal) != null ? num(o.selection_decimal) : amToDec(a);
    var db = num(o.opposite_decimal) != null ? num(o.opposite_decimal) : amToDec(b);
    if (num(o.given_probability) != null) {
      return { ok: true, probability: r4(num(o.given_probability)), method: str(o.given_method || 'MARKET_DEVIG'), source: str(o.given_source || 'the de-vigged reference market'), overround: null, both_sides: true, note: 'the no-vig probability was produced upstream by ' + str(o.given_method || 'the de-vig') + ' from both sides of the same market' };
    }
    if (da == null || db == null) {
      return { ok: false, probability: null, method: null, source: null, overround: null, both_sides: false, why: 'A no-vig probability needs BOTH sides of the same market at the same line. ' + (da == null && db == null ? 'Neither side' : 'Only one side') + ' is on file, and the break-even at a single price includes the book’s margin — it is not a market probability and is never compared against a model number.' };
    }
    var dv = Ik && typeof Ik.devigTwoWay === 'function' ? Ik.devigTwoWay(da, db, o.method) : null;
    if (!dv || !dv.ok) return { ok: false, probability: null, method: dv ? dv.method : null, source: null, overround: dv ? dv.overround : null, both_sides: true, why: dv ? dv.why : 'no de-vig is available on this host' };
    return { ok: true, probability: dv.p_a, method: 'NO_VIG_' + String(dv.method).toUpperCase(), source: str(o.source || 'both sides of the same market at the same line'), overround: dv.overround, vig_points: dv.vig_points, both_sides: true, limitation: dv.limitation };
  }

  /** How far apart the books are on this selection, in probability points. */
  function bookDisagreement(quotes) {
    var ps = (quotes || []).map(function (q) { var d = num(q.odds_decimal) != null ? num(q.odds_decimal) : amToDec(q.odds_american); return d && d > 1 ? 1 / d : null; }).filter(function (p) { return p != null; });
    if (ps.length < 2) return { books: ps.length, spread_pp: null, why: ps.length ? 'only one book is on file for this selection' : 'no book prices are on file for this selection' };
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
    return { books: ps.length, spread_pp: r2((hi - lo) * 100), best_implied: r4(lo), worst_implied: r4(hi), why: 'the ' + ps.length + ' captured prices for this selection imply probabilities ' + r2(lo * 100) + '% to ' + r2(hi * 100) + '%' };
  }

  /* ==================================================================== */
  /* 3. RELIABILITY                                                       */
  /* ==================================================================== */
  /**
   * A deterministic reliability score in [0.05, 0.95] from eight named parts.
   *
   * There is no narrative input. Every part is a number this stack already
   * owns, every weight is printed, and every contribution is stored with the
   * recommendation so a reader can see which part carried it.
   */
  function reliability(o) {
    o = o || {};
    var tier = str(o.tier || 'UNVALIDATED').toUpperCase();
    var v = {};
    v.calibration_record = o.calibration_available === false ? 0 : (TIER_RELIABILITY[tier] != null ? TIER_RELIABILITY[tier] : 0.1);
    var n = num(o.sample_n);
    v.effective_sample = n == null ? 0.2 : clamp(n / (n + 500), 0, 1);
    var comp = num(o.data_completeness);
    v.data_completeness = comp == null ? 0.4 : clamp(comp, 0, 1);
    var fresh = str(o.quote_freshness || 'UNKNOWN').toUpperCase();
    v.price_freshness = FRESH_WEIGHT[fresh] != null ? FRESH_WEIGHT[fresh] : 0.05;
    /* The decision layer already counted INDEPENDENT BOOK FAMILIES and ran its
       own confirmation test; a count of quote objects is not the same thing, and
       reading one as the other made every single-quote candidate look like a
       one-book market. So a passed confirmation IS agreement, a failed one is
       the absence of it, and a raw family count is used only when it exists. */
    var fam = num(o.book_families), wantFam = num(o.min_book_families) != null ? num(o.min_book_families) : 3;
    v.book_agreement = o.book_confirmed === true ? 1 : o.book_confirmed === false ? 0.2
      : fam == null ? 0.4 : clamp(fam / Math.max(1, wantFam), 0, 1);
    var av = str(o.availability_state || 'UNKNOWN').toUpperCase();
    v.availability_certainty = o.availability_unresolved === true ? 0 : (AVAIL_CERTAINTY[av] != null ? AVAIL_CERTAINTY[av] : 0.3);
    v.distribution_stability = o.distribution_validated === true ? 1 : o.distribution_validated === false ? 0.4 : 0.5;
    v.model_validation_status = o.model_version_validated === true ? 1 : o.model_version_validated === false ? 0.2 : 0.3;
    var comps = [], total = 0, wsum = 0;
    RELIABILITY_WEIGHTS.forEach(function (w) {
      var val = clamp(num(v[w.name]) != null ? num(v[w.name]) : 0, 0, 1);
      var contribution = r4(val * w.weight);
      total += val * w.weight; wsum += w.weight;
      comps.push({ name: w.name, value: r4(val), weight: w.weight, contribution: contribution, basis: w.basis, input: reliabilityInput(w.name, o) });
    });
    var score = clamp(wsum > 0 ? total / wsum : 0, 0.05, 0.95);
    return {
      score: r4(score), components: comps, weights_sum: r4(wsum),
      basis: 'a weighted mean of eight recorded components, clamped to [0.05, 0.95]: the score is never 1, because a reliability of 1 would be a claim of certainty',
      weakest: comps.slice().sort(function (a, b) { return a.value - b.value; })[0] || null
    };
  }
  function reliabilityInput(name, o) {
    if (name === 'calibration_record') return str(o.tier || 'UNVALIDATED') + (o.calibration_available === false ? ' (no calibration on file)' : '');
    if (name === 'effective_sample') return num(o.sample_n) == null ? 'no graded sample on file' : num(o.sample_n) + ' graded outcomes';
    if (name === 'data_completeness') return num(o.data_completeness) == null ? 'completeness not reported' : String(r2(num(o.data_completeness)));
    if (name === 'price_freshness') return str(o.quote_freshness || 'UNKNOWN');
    if (name === 'book_agreement') return o.book_confirmed === true ? 'the decision layer’s confirmation test passed (independent families or a sharp anchor)' : o.book_confirmed === false ? 'the decision layer’s confirmation test did not pass' : num(o.book_families) == null ? 'families not counted' : num(o.book_families) + ' independent families';
    if (name === 'availability_certainty') return o.availability_unresolved === true ? 'a decisive availability question is unresolved' : str(o.availability_state || 'UNKNOWN');
    if (name === 'distribution_stability') return o.distribution_validated === true ? 'the validated residual distribution' : o.distribution_validated === false ? 'a default residual sigma' : 'unknown provenance';
    if (name === 'model_validation_status') return o.model_version_validated === true ? 'validated model version' : o.model_version_validated === false ? 'unvalidated model version' : 'no model version recorded';
    return null;
  }

  /* ==================================================================== */
  /* 4. CONSERVATIVE PROBABILITY                                          */
  /* ==================================================================== */
  /**
   * The probability STAKING uses. Never the calibrated one.
   *
   * Order of preference:
   *   1. an empirical lower bound handed in (bootstrap, residual quantile);
   *   2. the fair line's own standard error pushed through the cover curve —
   *      a real lower confidence bound, because the curve and the error both
   *      come from the same held-out residuals;
   *   3. a shrink toward 50% by the reliability score, which is what is left
   *      when no interval has been measured.
   */
  function conservativeProbability(o) {
    o = o || {};
    var cal = num(o.calibrated_probability);
    var rel = num(o.reliability_score);
    if (cal == null) return { ok: false, probability: null, method: null, why: 'no calibrated probability to be conservative about' };
    if (num(o.lower_bound) != null) {
      var lb = clamp(num(o.lower_bound), 0.0001, 0.9999);
      return { ok: true, probability: r4(Math.min(lb, cal)), method: 'LOWER_BOUND_EMPIRICAL', shrunk_pp: r2((cal - Math.min(lb, cal)) * 100), basis: str(o.lower_bound_basis || 'an empirical lower confidence bound supplied with the probability'), why: 'the staking probability is the measured lower bound, not the point estimate' };
    }
    var Pk = P();
    if (Pk && num(o.fair_line_se) != null && num(o.fair_selection_line) != null && num(o.market_selection_line) != null && num(o.sigma) != null && typeof Pk.coverAt === 'function') {
      /* Move the fair line AGAINST the selection by one standard error: the
         selection needs more points, so the cover probability falls. */
      var se = Math.abs(num(o.fair_line_se)) * (num(o.z) != null ? num(o.z) : 1);
      var at = Pk.coverAt(num(o.fair_selection_line) - se, num(o.market_selection_line), num(o.sigma));
      if (at && num(at.cover) != null) {
        var bound = clamp(Math.min(num(at.cover), cal), 0.0001, 0.9999);
        return { ok: true, probability: r4(bound), method: 'LOWER_BOUND_FAIR_LINE_SE', shrunk_pp: r2((cal - bound) * 100), basis: 'the fair line moved ' + r2(se) + ' points against the selection (one standard error of the validated blend, from its held-out residuals) and read off the same cover curve', why: 'the staking probability is the cover probability at the unfavourable end of the fair line’s own error' };
      }
    }
    if (rel == null) return { ok: false, probability: null, method: null, why: 'no reliability score, so the calibrated probability cannot be shrunk and no lower bound was supplied' };
    var p = 0.5 + (cal - 0.5) * clamp(rel, 0, 1);
    return {
      ok: true, probability: r4(clamp(p, 0.0001, 0.9999)), method: 'SHRINK_TO_HALF_BY_RELIABILITY',
      shrunk_pp: r2((cal - p) * 100),
      formula: 'conservative = 0.50 + (calibrated - 0.50) x reliability',
      basis: 'reliability ' + r4(rel) + ' from the recorded components; no validated interval exists for this market, so the point estimate is pulled toward a coin flip by exactly how much is known',
      why: 'no empirical lower bound is on file for this sport and market, so the probability is shrunk toward 50% by the reliability score'
    };
  }

  /* ==================================================================== */
  /* 5. EXPECTED VALUE                                                    */
  /* ==================================================================== */
  /**
   * EV at the exact executable price, from the conservative probability, with
   * pushes returning the stake and adding nothing.
   */
  function expectedValue(o) {
    o = o || {};
    var Ik = I();
    var dec = num(o.decimal_odds) != null ? num(o.decimal_odds) : amToDec(o.american_odds);
    var pCons = num(o.conservative_probability), pCal = num(o.calibrated_probability), pMkt = num(o.no_vig_market_probability);
    var push = num(o.push_probability) || 0;
    var out = {
      decimal_odds: r4(dec), american_odds: dec != null ? decToAm(dec) : null,
      conservative_probability: r4(pCons), calibrated_probability: r4(pCal), no_vig_market_probability: r4(pMkt), push_probability: r4(push),
      break_even_probability: null, expected_value: null, expected_profit_per_unit: null,
      model_edge: null, conservative_edge: null, fair_decimal_odds: null, fair_american_odds: null,
      formula: 'EV = (p x d) - 1 with p the CONSERVATIVE probability and d the decimal price actually available; a push returns the stake and contributes no profit',
      why: null
    };
    if (dec == null || dec <= 1) { out.why = 'no usable executable price, so there is no expected value'; return out; }
    out.break_even_probability = Ik && typeof Ik.breakEvenProb === 'function' ? Ik.breakEvenProb(dec, push) : r4((1 - push) / dec);
    if (pCons == null) { out.why = 'no conservative probability, so no expected value is computed. A line difference is not a probability.'; return out; }
    var e = Ik && typeof Ik.ev === 'function' ? Ik.ev({ dec: dec, p_win: pCons, p_push: push }) : null;
    if (e && num(e.ev) != null) { out.expected_value = r4(e.ev); out.p_loss = e.p_loss; }
    else { var pl = Math.max(0, 1 - pCons - push); out.expected_value = r4(pCons * (dec - 1) - pl); out.p_loss = r4(pl); }
    out.expected_profit_per_unit = out.expected_value;
    if (pCal != null && pMkt != null) out.model_edge = r4(pCal - pMkt);
    if (pMkt != null) out.conservative_edge = r4(pCons - pMkt);
    /* the fair odds of the CONSERVATIVE probability: the price at which this
       wager is exactly break-even under the number EdgeDesk stakes on */
    out.fair_decimal_odds = r4((1 - push) / pCons);
    out.fair_american_odds = decToAm(out.fair_decimal_odds);
    if (pCal != null) { out.calibrated_fair_decimal_odds = r4((1 - push) / pCal); out.calibrated_fair_american_odds = decToAm(out.calibrated_fair_decimal_odds); }
    return out;
  }

  /* ==================================================================== */
  /* 6. UNITS                                                            */
  /* ==================================================================== */
  /** Full Kelly, the configured fraction, and the bankroll fraction in units. */
  function kelly(o) {
    o = o || {};
    var dec = num(o.decimal_odds) != null ? num(o.decimal_odds) : amToDec(o.american_odds);
    var p = num(o.conservative_probability);
    var mult = num(o.fractional_kelly_multiplier);
    if (mult == null) mult = DEFAULT_POLICY.fractional_kelly_multiplier;
    var out = { decimal_odds: r4(dec), b: null, p: r4(p), q: null, full_kelly_fraction: null, fractional_kelly_fraction: null, multiplier: mult, stake_dollars: null, raw_units: null, formula: 'b = d - 1; full = ((b x p) - q) / b; fractional = max(0, full x multiplier)', why: null };
    if (dec == null || dec <= 1 || p == null) { out.why = 'no price or no conservative probability, so there is no Kelly fraction'; return out; }
    var b = dec - 1, q = 1 - p;
    var full = ((b * p) - q) / b;
    var frac = Math.max(0, full * mult);
    out.b = r4(b); out.q = r4(q); out.full_kelly_fraction = r4(full); out.fractional_kelly_fraction = r6(frac);
    if (full <= 0) out.why = 'full Kelly is ' + r4(full) + ': at this price the conservative probability does not beat the break-even, so the stake is zero';
    var bank = num(o.bankroll_amount), unit = num(o.base_unit_amount), uf = num(o.unit_fraction_of_bankroll);
    if (bank != null && unit != null && unit > 0) { out.stake_dollars = r2(bank * frac); out.raw_units = r6(out.stake_dollars / unit); out.units_basis = 'stake_dollars = bankroll ' + fmtMoney(bank) + ' x ' + r6(frac) + '; raw_units = stake_dollars / base unit ' + fmtMoney(unit); }
    else if (uf != null && uf > 0) { out.raw_units = r6(frac / uf); out.units_basis = 'raw_units = fractional Kelly ' + r6(frac) + ' / the stated one-unit-is-' + (uf * 100) + '%-of-bankroll convention; no bankroll amount was assumed'; }
    else out.why = (out.why ? out.why + '; ' : '') + 'no bankroll and no unit convention, so a fraction cannot become units';
    return out;
  }

  /** Round DOWN to a permitted size. Below the minimum is zero, never rounded up. */
  function roundUnits(u, policy) {
    var allowed = (policy && policy.allowed_unit_sizes) || DEFAULT_POLICY.allowed_unit_sizes;
    var minU = (policy && num(policy.minimum_unit_size)) != null ? num(policy.minimum_unit_size) : DEFAULT_POLICY.minimum_unit_size;
    var n = num(u);
    if (n == null || !(n > 0)) return { units: 0, rounded_from: n, why: 'nothing to round: the sized fraction is zero or unavailable' };
    var pick = 0;
    allowed.forEach(function (a) { if (a <= n + 1e-9 && a > pick) pick = a; });
    if (pick < minU - 1e-9) return { units: 0, rounded_from: r4(n), why: r4(n) + 'u rounds DOWN to ' + pick + 'u, below the ' + minU + 'u minimum this policy will place, so the answer is 0u' };
    return { units: r2(pick), rounded_from: r4(n), why: r4(n) + 'u rounded DOWN to the permitted ' + pick + 'u (sizes are never rounded up)' };
  }
  function tierFor(units) {
    var n = num(units) || 0;
    var best = TIERS[0];
    TIERS.forEach(function (t) { if (Math.abs(t.units - n) < 1e-9) best = t; });
    if (Math.abs(best.units - n) > 1e-9) { /* a configured size with no named tier */ return { tier: n > 0 ? 'SIZED' : 'PASS', units: n, label: n > 0 ? n.toFixed(2) + 'u' : 'PASS — 0u' }; }
    return best;
  }

  /* ==================================================================== */
  /* 7. THE EXPOSURE LEDGER                                              */
  /*                                                                      */
  /* Pending singles, pending parlays and already submitted positions, in  */
  /* one place, because a cap that only knows about this turn's card is    */
  /* not a cap. Teams are normalised through EDINTEL so "Pittsburgh" and   */
  /* "Pittsburgh Panthers" are one exposure rather than two.               */
  /* ==================================================================== */
  function teamsOf(p) {
    var out = [];
    if (Array.isArray(p.teams)) p.teams.forEach(function (t) { if (t) out.push(t); });
    /* A spread or moneyline is exposure to ONE team. A total is exposure to
       the game script of BOTH, which is why both are counted for a total. */
    if (!out.length) {
      var m = normMarket(p.market);
      if (m === 'totals') { if (p.home) out.push(p.home); if (p.away) out.push(p.away); }
      else if (p.selection) out.push(p.selection);
      else { if (p.home) out.push(p.home); if (p.away) out.push(p.away); }
    }
    return uniq(out.map(normName).filter(Boolean));
  }
  function exposureLedger(o) {
    o = o || {};
    var tz = o.timezone || null;
    var rows = (o.positions || []).map(function (p, i) {
      var units = num(p.units) != null ? num(p.units) : num(p.stake_units);
      return {
        idx: i, kind: str(p.kind || 'SINGLE').toUpperCase(), sport: str(p.sport) || null, game_id: p.game_id != null ? String(p.game_id) : null,
        market: normMarket(p.market), side: p.side || null, selection: str(p.selection) || null, line: num(p.line),
        units: units != null ? units : 0, teams: teamsOf(p), kickoff: iso(p.kickoff),
        day: p.kickoff ? localDate(toMs(p.kickoff), tz) : null, week: p.kickoff ? weekKey(toMs(p.kickoff), tz) : null,
        ticket_id: p.ticket_id != null ? String(p.ticket_id) : null, source: str(p.source || 'carried position')
      };
    });
    var byGame = {}, byTeam = {}, bySport = {}, byDay = {}, byWeek = {}, bySelection = {}, teamCount = {};
    rows.forEach(function (r) {
      var gk = r.sport + '|' + r.game_id;
      byGame[gk] = r2((byGame[gk] || 0) + r.units);
      if (r.sport) bySport[r.sport] = r2((bySport[r.sport] || 0) + r.units);
      if (r.day) byDay[r.day] = r2((byDay[r.day] || 0) + r.units);
      if (r.week) byWeek[r.week] = r2((byWeek[r.week] || 0) + r.units);
      r.teams.forEach(function (t) { byTeam[t] = r2((byTeam[t] || 0) + r.units); teamCount[t] = (teamCount[t] || 0) + 1; });
      var sk = r.sport + '|' + r.game_id + '|' + r.market + '|' + (r.side || normName(r.selection));
      bySelection[sk] = r2((bySelection[sk] || 0) + r.units);
    });
    return {
      schema: 'edgedesk_exposure_ledger_v1', timezone: tz, positions: rows,
      by_game: byGame, by_team: byTeam, by_sport: bySport, by_day: byDay, by_week: byWeek, by_selection: bySelection, positions_per_team: teamCount,
      total_units: r2(rows.reduce(function (s, r) { return s + r.units; }, 0)),
      note: 'Pending singles, pending parlay legs and submitted positions all count against the caps. A total is exposure to both teams, because one game script decides it.'
    };
  }
  function ledgerFor(c, ledger, tz) {
    var gk = c.sport + '|' + c.game_id;
    var teams = teamsOf(c);
    var day = c.kickoff ? localDate(toMs(c.kickoff), tz) : null, wk = c.kickoff ? weekKey(toMs(c.kickoff), tz) : null;
    var teamUnits = 0, teamKey = null, positions = 0;
    teams.forEach(function (t) { var u = num(ledger.by_team[t]) || 0; if (u >= teamUnits) { teamUnits = u; teamKey = t; } positions = Math.max(positions, num(ledger.positions_per_team[t]) || 0); });
    /* the key is normalised so two spellings of one program are one exposure; the LABEL is what the reader typed, so the prose never prints a normalised key */
    var label = null;
    [c.selection, c.home, c.away].forEach(function (n) { if (!label && n && normName(n) === teamKey) label = n; });
    return { game: num(ledger.by_game[gk]) || 0, team: teamUnits, team_key: teamKey, team_label: label || teamKey, teams: teams, sport: num(ledger.by_sport[c.sport]) || 0, day: day ? (num(ledger.by_day[day]) || 0) : 0, week: wk ? (num(ledger.by_week[wk]) || 0) : 0, day_key: day, week_key: wk, positions_on_team: positions };
  }
  /** Add one sized recommendation to a ledger, in place, so the next one sees it. */
  function addToLedger(ledger, c, units, kind, tz) {
    if (!(num(units) > 0)) return ledger;
    var p = { kind: kind || 'SINGLE', sport: c.sport, game_id: c.game_id, market: c.market, side: c.side, selection: c.selection, line: c.line, units: units, kickoff: c.kickoff, home: c.home, away: c.away, teams: c.teams || null, source: 'this card' };
    var next = exposureLedger({ positions: ledger.positions.map(function (r) { return { kind: r.kind, sport: r.sport, game_id: r.game_id, market: r.market, side: r.side, selection: r.selection, line: r.line, units: r.units, kickoff: r.kickoff, teams: r.teams, ticket_id: r.ticket_id, source: r.source }; }).concat([p]), timezone: tz });
    return next;
  }

  /* ==================================================================== */
  /* 8. CORRELATION AND DUPLICATION                                       */
  /*                                                                      */
  /* Two tickets that one quarterback decides are one ticket with two      */
  /* receipts. The rules below name the relationship rather than scoring   */
  /* it, because a made-up correlation coefficient is as bad as a made-up  */
  /* probability.                                                          */
  /* ==================================================================== */
  function correlations(c, ledger) {
    var out = [];
    var teams = teamsOf(c);
    var gk = c.sport + '|' + c.game_id;
    (ledger.positions || []).forEach(function (r) {
      var sameGame = (r.sport + '|' + r.game_id) === gk;
      var sameMarket = sameGame && r.market === c.market;
      var sameSide = sameMarket && ((r.side && c.side && r.side === c.side) || (r.selection && c.selection && normName(r.selection) === normName(c.selection)));
      var shared = teams.filter(function (t) { return r.teams.indexOf(t) >= 0; });
      if (sameSide) { out.push({ kind: 'DUPLICATE_SELECTION', with: r.selection + ' (' + r.kind.toLowerCase() + ')', units: r.units, why: 'the same selection is already on the card; a second ticket on it is more of one position, not a second position' }); return; }
      if (sameMarket) { out.push({ kind: 'OPPOSING_POSITION', with: r.selection, units: r.units, why: 'the other side of the same market is already on the card; the two cannot both win and the vig is paid twice' }); return; }
      if (sameGame) { out.push({ kind: 'SAME_GAME', with: r.selection + ' ' + marketWord(r.market), units: r.units, why: 'one game script decides both: a side and a total in the same game move together and are not two independent positions' }); return; }
      if (shared.length) { out.push({ kind: 'SHARED_TEAM', with: r.selection + ' (' + marketWord(r.market) + ')', units: r.units, team: shared[0], why: 'the same team appears in both positions, so one team’s day decides both' }); }
    });
    return out;
  }

  /* ==================================================================== */
  /* 9. THE GATES, AND ONE RECOMMENDATION                                 */
  /* ==================================================================== */
  /**
   * Evaluate ONE candidate into the response contract.
   *
   * `c` is a normalised candidate (see candidateFromBoard / candidateFromSide):
   *   ids, market, selection, line, the quote, the calibrated probability with
   *   its source and tier, the no-vig market probability, the reliability
   *   inputs, the counter-case and the invalidation conditions.
   * `o.settings` is the policy, `o.ledger` the exposure ledger.
   *
   * Returns the object the AI is handed. Every number in it was computed here.
   */
  function evaluate(c, o) {
    o = o || {};
    var S = o.settings || settings(null, {});
    var tz = o.timezone || null;
    var ledger = o.ledger || exposureLedger({ positions: [], timezone: tz });
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var warnings = (c.warnings || []).slice();
    var failed = [];
    function gate(code, detail) { var g = GATE_BY_CODE[code]; failed.push({ code: code, status: g ? g.status : 'RESEARCH_ONLY', why: g ? g.why : code, detail: detail || null }); }

    /* ---- the quote ---------------------------------------------------- */
    var q = c.quote || {};
    var qc = quoteCheck(q);
    var dec = qc.decimal, am = qc.american;
    if (!SIZEABLE_MARKETS[c.market] && !VALIDATED_EXTRA_MARKETS[c.sport + '|' + c.market]) gate('MARKET_OUT_OF_SCOPE', (CONDITIONAL_MARKETS[c.market] ? 'EdgeDesk has no separately validated ' + CONDITIONAL_MARKETS[c.market] + ' model, so this market is research only and is never approximated from the game line' : 'market ' + c.market + ' is not in the sizeable set (' + Object.keys(SIZEABLE_MARKETS).join(', ') + ')'));
    if (c.market_definition_mismatch) gate('MARKET_DEFINITION_MISMATCH', c.market_definition_mismatch);
    if (!q.executable || dec == null) gate('NO_EXECUTABLE_QUOTE', qc.problems.join('; ') || 'no executable price');
    else if (!q.book || !q.captured_at) gate('ODDS_UNVERIFIED', qc.problems.join('; ') || 'the price carries no book or no capture time');
    else if (!FRESH_OK[qc.freshness]) gate('STALE_PRICE', 'the captured price is ' + qc.freshness + (num(q.age_seconds) != null ? ' (' + Math.round(num(q.age_seconds) / 60) + ' minutes old)' : ''));
    if (c.book_confirmed === false) gate('THIN_MARKET', 'the decision layer’s confirmation test did not pass: no independent book family and no sharp anchor corroborates this number');
    else if (c.book_confirmed !== true && num(c.book_families) != null && num(c.book_families) < num(S.minimum_book_families)) gate('THIN_MARKET', num(c.book_families) + ' independent book families behind the number; this policy wants ' + S.minimum_book_families);
    var smode = c.probability_source === 'MODEL_BLEND' ? stakingModeFor(c.sport, c.market) : { mode: 'UNREGISTERED', loaded: false };
    if (smode.loaded && smode.mode !== 'BET') gate('MARKET_IN_SHADOW_MODE', smode.mode + ': ' + smode.basis);
    if (c.calibration_available === false) gate('NO_CALIBRATION', c.calibration_note || 'no calibration record for ' + c.sport + ' ' + marketWord(c.market));
    if (c.model_version_validated === false && c.probability_source !== 'MARKET_DEVIG') gate('MODEL_VERSION_UNVALIDATED', 'model version ' + str(c.model_version || 'unknown') + ' has no validation record permitting a betting probability');
    if (num(c.data_completeness) != null && num(c.data_completeness) < num(S.minimum_data_completeness)) gate('DATA_COMPLETENESS_BELOW_FLOOR', 'completeness ' + r2(num(c.data_completeness)) + ' is under the ' + S.minimum_data_completeness + ' floor');
    if (c.availability_unresolved === true) gate('CRITICAL_AVAILABILITY_UNRESOLVED', c.availability_note || 'a decisive starter or lineup question is open');
    if (c.inferred_inputs === true) gate('FABRICATED_OR_INFERRED_DATA', c.inferred_note || 'an input behind this number was inferred rather than observed');

    /* ---- the probabilities -------------------------------------------- */
    var mkt = c.no_vig || noVig({ given_probability: c.no_vig_market_probability, given_method: c.no_vig_method, given_source: c.no_vig_source, selection_american: q.odds_american, opposite_american: c.opposite_american });
    var rel = reliability({
      tier: c.tier, calibration_available: c.calibration_available, sample_n: c.sample_n, data_completeness: c.data_completeness,
      quote_freshness: qc.freshness, book_families: c.book_families, book_confirmed: c.book_confirmed, min_book_families: S.minimum_book_families,
      availability_state: c.availability_state, availability_unresolved: c.availability_unresolved,
      distribution_validated: c.distribution_validated, model_version_validated: c.model_version_validated
    });
    var cons = conservativeProbability({
      calibrated_probability: c.calibrated_probability, reliability_score: rel.score,
      lower_bound: c.lower_bound, lower_bound_basis: c.lower_bound_basis,
      fair_line_se: c.fair_line_se, fair_selection_line: c.fair_selection_line, market_selection_line: c.line, sigma: c.sigma
    });
    if (rel.score < num(S.minimum_reliability)) gate('RELIABILITY_BELOW_FLOOR', 'reliability ' + r4(rel.score) + ' is under the ' + S.minimum_reliability + ' floor (weakest component: ' + (rel.weakest ? rel.weakest.name + ' at ' + rel.weakest.value : 'n/a') + ')');
    var EV = expectedValue({
      decimal_odds: dec, conservative_probability: cons.probability, calibrated_probability: c.calibrated_probability,
      no_vig_market_probability: mkt.ok ? mkt.probability : null, push_probability: c.push_probability
    });
    if (EV.expected_value == null || EV.expected_value <= num(S.minimum_conservative_ev)) {
      gate('CONSERVATIVE_EV_NOT_POSITIVE', EV.expected_value == null ? (EV.why || 'no expected value could be computed') : 'conservative EV ' + pp(EV.expected_value, 2) + ' at ' + fmtAm(am) + ' does not clear the ' + pp(num(S.minimum_conservative_ev), 2) + ' floor; the price would have to be ' + fmtAm(EV.fair_american_odds) + ' or better');
    }
    if (c.price_limit_american != null && am != null && !priceAtLeast(am, c.price_limit_american)) gate('LINE_MOVED_PAST_PLAYABLE', 'the available price ' + fmtAm(am) + ' is worse than EdgeDesk’s limit of ' + fmtAm(c.price_limit_american) + ' at this number');

    /* ---- the size ----------------------------------------------------- */
    var K = kelly({ decimal_odds: dec, conservative_probability: cons.probability, fractional_kelly_multiplier: S.fractional_kelly_multiplier, bankroll_amount: S.bankroll_amount, base_unit_amount: S.base_unit_amount, unit_fraction_of_bankroll: S.unit_fraction_of_bankroll });
    var have = ledgerFor(c, ledger, tz);
    var caps = capsFor({ candidate: c, settings: S, reliability: rel.score, have: have });
    var rawU = num(K.raw_units) || 0;
    var capped = rawU, binding = null;
    caps.forEach(function (cap) { if (num(cap.limit_units) != null && num(cap.limit_units) < capped) { capped = num(cap.limit_units); binding = cap; } });
    if (capped < 0) capped = 0;
    var rounded = roundUnits(capped, S);
    /* A CAP THAT TRIMS IS NOT A GATE THAT REFUSES.
       An exposure cap doing its job means a SMALLER position, not no position:
       0.75u already on the game leaves 0.50u of a 1.25u cap, and 0.50u is the
       right answer. Only a cap that leaves NOTHING is a refusal, and it is
       reported as a PASS with the cap named. Firing the gate on every trim
       turned every correctly-capped wager into a 0u PASS — the caps would have
       silenced the engine on exactly the second and third positions they exist
       to size. */
    var capTrimmed = !!(binding && /GAME|TEAM|DAILY|WEEKLY|POSITIONS/.test(binding.code) && capped < rawU);
    if (capTrimmed && rounded.units === 0) gate('EXPOSURE_CAP', binding.why);
    if (rounded.units === 0 && rawU > 0 && !failed.some(function (f) { return f.code === 'EXPOSURE_CAP' || f.code === 'CONSERVATIVE_EV_NOT_POSITIVE'; })) gate('BELOW_MINIMUM_UNIT', rounded.why);

    /* ---- the status ---------------------------------------------------
       THE FIRST FAILING GATE DECIDES, in the order the table prints them —
       which is also the order of severity, RESEARCH_ONLY before PASS before
       WATCH. Sorting by the table rather than by the order the checks
       happened to run means the status cannot depend on the shape of the
       code, and `gates_note` is then a true statement about it. */
    failed.sort(function (a, b) { return gateIndex(a.code) - gateIndex(b.code); });
    var hard = failed.filter(function (f) { return f.status === 'RESEARCH_ONLY'; });
    var units = failed.length ? 0 : rounded.units;
    var status = failed.length ? failed[0].status : (units > 0 ? 'BET' : 'PASS');
    /* A WATCH is a positive-EV wager the SIZE refused, not the value: it earns
       a threshold, never a stake. */
    var tier = tierFor(units);
    var dollars = units > 0 && S.dollars_exact && num(S.base_unit_amount) != null ? r2(units * num(S.base_unit_amount)) : null;
    if (units > 0 && dollars == null) warnings.push('UNITS_ONLY: ' + S.dollars_note);
    if (mkt.ok && mkt.probability != null && c.calibrated_probability != null && Math.abs(c.calibrated_probability - mkt.probability) < 1e-9) warnings.push('The calibrated probability IS the no-vig market probability here: the edge is entirely in the price (line shopping), not in a model disagreement, so the model edge is zero by construction.');
    if (!mkt.ok) warnings.push('NO_NO_VIG_MARKET_PROBABILITY: ' + mkt.why + ' The expected value below is still computed at the exact executable price, which is the gate that decides the wager.');
    if (cons.method === 'SHRINK_TO_HALF_BY_RELIABILITY') warnings.push('No validated interval exists for this market, so the staking probability is a reliability shrink rather than a measured lower bound.');
    var corr = correlations(c, ledger);
    var after = units > 0 ? r2(have.team + units) : r2(have.team);

    var rec = {
      schema: SCHEMA, version: VERSION,
      event_id: str(c.game_id), sport: str(c.sport), sport_label: c.sport_label || null,
      matchup: c.matchup || null, kickoff: iso(c.kickoff), kickoff_local: c.kickoff_local || null,
      market: marketWord(c.market), market_key: c.market, selection: str(c.selection),
      line: num(c.line), american_odds: am, decimal_odds: dec, sportsbook: q.book || null,
      price_captured_at: iso(q.captured_at), price_age_seconds: num(q.age_seconds) != null ? Math.round(num(q.age_seconds)) : (q.captured_at ? Math.round((now - toMs(q.captured_at)) / 1000) : null),
      price_freshness: qc.freshness, price_executable: !!q.executable,
      model_probability: r4(c.model_probability != null ? c.model_probability : c.raw_probability),
      calibrated_probability: r4(c.calibrated_probability),
      conservative_probability: cons.probability,
      conservative_method: cons.method, conservative_basis: cons.basis || cons.why || null,
      no_vig_market_probability: mkt.ok ? mkt.probability : null,
      no_vig_method: mkt.ok ? mkt.method : null, no_vig_source: mkt.ok ? mkt.source : mkt.why,
      book_disagreement: c.book_disagreement || null,
      model_edge: EV.model_edge, conservative_edge: EV.conservative_edge,
      expected_value: EV.expected_value, expected_profit_per_unit: EV.expected_profit_per_unit,
      break_even_probability: EV.break_even_probability, push_probability: EV.push_probability,
      fair_odds: EV.fair_american_odds, fair_decimal_odds: EV.fair_decimal_odds,
      fair_line: num(c.fair_selection_line) != null ? r2(num(c.fair_selection_line)) : null,
      reliability_score: rel.score, reliability_components: rel.components, reliability_basis: rel.basis,
      raw_kelly_fraction: K.full_kelly_fraction, fractional_kelly_fraction: K.fractional_kelly_fraction,
      kelly_multiplier: S.fractional_kelly_multiplier, kelly_stake_dollars: K.stake_dollars, kelly_raw_units: K.raw_units, kelly_basis: K.units_basis || K.why,
      recommended_units: units, recommended_dollars: dollars,
      recommendation_tier: tier.tier, recommendation_label: tier.label,
      caps_applied: caps, binding_cap: binding ? binding.code : null, rounding: rounded,
      cap_trimmed: capTrimmed, cap_trimmed_note: capTrimmed ? 'the size was reduced from ' + r2(rawU) + 'u to ' + fmtUnits(rounded.units) + ' by the ' + binding.code + ' cap: ' + binding.why : null,
      primary_reason: primaryReason(c, EV, cons, rel, units, status, binding),
      strongest_counterargument: c.counter || 'Not stated by the layer that produced this number, which is itself a reason to be careful.',
      invalidation_conditions: (c.invalidation || []).slice(0, 6),
      existing_team_exposure_units: r2(have.team), resulting_team_exposure_units: after,
      existing_game_exposure_units: r2(have.game), resulting_game_exposure_units: units > 0 ? r2(have.game + units) : r2(have.game),
      existing_daily_exposure_units: r2(have.day), resulting_daily_exposure_units: units > 0 ? r2(have.day + units) : r2(have.day),
      existing_weekly_exposure_units: r2(have.week), resulting_weekly_exposure_units: units > 0 ? r2(have.week + units) : r2(have.week),
      exposure_keys: { team: have.team_key, team_label: have.team_label, teams: have.teams, day: have.day_key, week: have.week_key, positions_on_team: have.positions_on_team },
      correlated_exposure: corr,
      warnings: uniq(warnings).slice(0, 10),
      gates_failed: failed, gates_note: failed.length ? 'the first gate in EdgeDesk’s printed order decides the status (' + failed[0].code + ' → ' + failed[0].status + '); every other gate that fired is listed so nothing is hidden' : 'every gate passed',
      model_version: str(c.model_version || ''), calibration_version: str(c.calibration_version || ''),
      probability_source: str(c.probability_source || ''), fair_method: c.fair_method || null,
      validation_tier: str(c.tier || 'UNVALIDATED'), validation_basis: c.tier_basis || null,
      staking_mode: smode.loaded ? smode.mode : null, staking_mode_basis: smode.loaded ? smode.basis : null,
      price_limit_american: num(c.price_limit_american), bet_to_line: num(c.bet_to_line),
      alternates: null,
      status: status,
      policy: { schema: POLICY_SCHEMA, kelly_multiplier: S.fractional_kelly_multiplier, max_single: S.maximum_single_wager_units, max_game: S.maximum_game_exposure_units, max_team: S.maximum_team_exposure_units, max_daily: S.maximum_daily_exposure_units, max_weekly: S.maximum_weekly_exposure_units, bankroll_known: S.bankroll_known, base_unit_amount: S.base_unit_amount, dollars_exact: S.dollars_exact, sources: S.sources },
      note: 'Every number above is computed by EdgeDesk from stored records. A recommendation is a position size at the quoted price, not a claim about the result, and PASS is a successful answer.'
    };
    rec.id = c.id || (c.sport + '|' + c.game_id + '|' + c.market + '|' + (c.side || normName(c.selection)));
    rec.recommendation_id = 'stake_' + fnv1a([rec.id, rec.line, rec.american_odds, rec.sportsbook, rec.price_captured_at, rec.model_version, rec.conservative_probability, rec.recommended_units].join('|'));
    return rec;
  }
  /** Is `have` at least as good a price as `want`? American odds, both signs. */
  function priceAtLeast(have, want) {
    var h = amToDec(have), w = amToDec(want);
    if (h == null || w == null) return true;
    return h >= w - 1e-9;
  }
  function capsFor(o) {
    var c = o.candidate, S = o.settings, rel = num(o.reliability), have = o.have;
    var tierKey = c.probability_source === 'MARKET_DEVIG' ? 'MARKET_DEVIG' : str(c.tier || 'RESEARCH').toUpperCase();
    var tierCap = num(S.tier_unit_cap ? S.tier_unit_cap[tierKey] : null);
    if (tierCap == null) tierCap = 0;
    var relCap = null;
    (S.reliability_unit_cap || DEFAULT_POLICY.reliability_unit_cap).forEach(function (r) { if (relCap == null && (r.below == null || rel < r.below)) relCap = num(r.units); });
    if (relCap == null) relCap = num(S.maximum_single_wager_units);
    var caps = [
      { code: 'MAX_SINGLE', limit_units: num(S.maximum_single_wager_units), basis: 'the policy’s maximum on one wager', why: 'the maximum single wager under this policy is ' + S.maximum_single_wager_units + 'u' },
      { code: 'TIER', limit_units: tierCap, basis: 'the validation tier for this probability (' + tierKey + ')', why: tierCap === 0 ? 'a ' + tierKey + ' tier may not produce a stake at all: the arithmetic is research, not a price' : 'a ' + tierKey + ' tier permits at most ' + tierCap + 'u' },
      { code: 'RELIABILITY', limit_units: relCap, basis: 'the reliability score ' + r4(rel), why: relCap === 0 ? 'the reliability score ' + r4(rel) + ' is below the floor this policy stakes on' : 'reliability ' + r4(rel) + ' permits at most ' + relCap + 'u' },
      { code: 'GAME', limit_units: r2(num(S.maximum_game_exposure_units) - have.game), basis: 'the game cap less what is already on this game', why: 'this game already carries ' + fmtUnits(have.game) + ' of the ' + S.maximum_game_exposure_units + 'u cap' },
      { code: 'TEAM', limit_units: r2(num(S.maximum_team_exposure_units) - have.team), basis: 'the team cap less what is already on this team', why: (have.team_label || have.team_key || 'this team') + ' already carries ' + fmtUnits(have.team) + ' of the ' + S.maximum_team_exposure_units + 'u cap' },
      { code: 'DAILY', limit_units: r2(num(S.maximum_daily_exposure_units) - have.day), basis: 'the daily cap less what is already staked on ' + (have.day_key || 'that day'), why: (have.day_key || 'that day') + ' already carries ' + fmtUnits(have.day) + ' of the ' + S.maximum_daily_exposure_units + 'u cap' },
      { code: 'WEEKLY', limit_units: r2(num(S.maximum_weekly_exposure_units) - have.week), basis: 'the weekly cap less what is already staked in the week of ' + (have.week_key || 'that week'), why: 'the week already carries ' + fmtUnits(have.week) + ' of the ' + S.maximum_weekly_exposure_units + 'u cap' }
    ];
    if (num(have.positions_on_team) >= num(S.maximum_positions_per_team)) caps.push({ code: 'POSITIONS_PER_TEAM', limit_units: 0, basis: 'the cap on how many tickets may involve one team', why: (have.team_label || have.team_key || 'this team') + ' already appears in ' + have.positions_on_team + ' recommended positions, the maximum this policy allows' });
    return caps;
  }
  function primaryReason(c, EV, cons, rel, units, status, binding) {
    if (status === 'RESEARCH_ONLY') return 'Research only: ' + (c.research_reason || 'EdgeDesk cannot price this selection to a stake right now') + '.';
    var priced = 'At ' + fmtAm(EV.american_odds) + (c.quote && c.quote.book ? ' at ' + c.quote.book : '') + ' the price requires ' + pct(EV.break_even_probability) + '; EdgeDesk’s calibrated probability is ' + pct(c.calibrated_probability) + ' and the staking probability after uncertainty is ' + pct(cons.probability) + ', for ' + pp(EV.expected_value, 1) + ' expected value per unit';
    /* NAME THE CONSTRAINT THAT ACTUALLY BOUND. "the exposure caps" was printed
       whatever held the size down, including a validation tier or the
       reliability floor, which are not exposure and not caps on this wager. */
    if (units > 0) return priced + '. ' + (c.primary_reason ? c.primary_reason + ' ' : '') + 'Reliability ' + r4(rel.score)
      + (binding ? ' and the ' + binding.code.toLowerCase().replace(/_/g, ' ') + ' limit put the size at ' + fmtUnits(units) + ' (' + binding.why + ')' : ' puts the size at ' + fmtUnits(units) + ', with no cap binding') + '.';
    if (status === 'WATCH') return priced + ', which is positive but not enough to clear this policy’s size floor at ' + fmtUnits(0) + '. It is a watch with a threshold, not a bet.';
    return priced + '. ' + (EV.expected_value != null && EV.expected_value <= 0 ? 'That is not positive, so the correct answer is PASS.' : 'A gate below refused the stake, so the answer is PASS.');
  }

  /* ==================================================================== */
  /* 10. CANDIDATE ADAPTERS                                               */
  /*                                                                      */
  /* The ONLY way a number enters this kernel. Each adapter reads an       */
  /* object another layer already built and names where every probability  */
  /* came from. Nothing is derived from a line difference.                 */
  /* ==================================================================== */
  /**
   * From one EDBOARD candidate (either pricing method).
   *
   * MARKET_DEVIG: the calibrated probability IS the de-vigged reference
   * market, so the model edge is zero by construction and the whole edge is
   * in the price. That is said out loud rather than dressed up as a model
   * disagreement.
   *
   * MODEL_BLEND: the calibrated probability is the blend's cover probability
   * at the quoted number, and its tier decides whether it may be staked at
   * all.
   */
  function candidateFromBoard(c, o) {
    o = o || {};
    if (!c || !c.fair) return null;
    var isDevig = c.fair.method === 'MARKET_DEVIG';
    var tier = (c.fair.validation && c.fair.validation.tier) || (isDevig ? 'MARKET_DEVIG' : 'RESEARCH');
    var q = c.quote || {};
    var ageS = num(q.age_min) != null ? num(q.age_min) * 60 : (q.captured_at && o.now ? Math.max(0, (toMs(o.now) - toMs(q.captured_at)) / 1000) : null);
    var mainLine = num(o.main_market_line);
    var mismatch = null;
    if (mainLine != null && num(c.line) != null && c.market !== 'h2h') {
      var tolerance = c.market === 'totals' ? 1.5 : 1;
      if (Math.abs(num(c.line) - mainLine) > tolerance) mismatch = 'the quoted number ' + fmtLine(c.line) + ' is ' + r2(Math.abs(num(c.line) - mainLine)) + ' points off the main market line ' + fmtLine(mainLine) + '; an alternate number priced off the main line’s fair value is a different market, and EdgeDesk will not present it as the main one';
    }
    return {
      id: c.id, sport: c.sport, sport_label: c.sport_label, game_id: String(c.game_id), matchup: c.matchup,
      home: c.home, away: c.away, kickoff: c.kickoff, kickoff_local: c.kickoff_local || null,
      market: c.market, side: c.side, selection: c.selection, line: num(c.line),
      quote: { book: q.book, odds_american: num(q.odds_american), odds_decimal: num(q.odds_decimal), captured_at: q.captured_at, freshness: q.freshness, executable: !!q.executable, actionable: !!q.actionable, age_seconds: ageS != null ? Math.round(ageS) : null, source: q.source || null },
      probability_source: isDevig ? 'MARKET_DEVIG' : 'MODEL_BLEND',
      fair_method: c.fair.method, fair_label: c.fair.label || null,
      model_probability: isDevig ? null : num(c.fair.probability),
      calibrated_probability: num(c.fair.probability),
      no_vig_market_probability: isDevig ? num(c.fair.probability) : (num(o.no_vig_market_probability) != null ? num(o.no_vig_market_probability) : null),
      no_vig_method: isDevig ? (c.fair.label || 'MARKET_DEVIG') : (o.no_vig_method || null),
      no_vig_source: isDevig ? 'the de-vigged sharp reference market, both sides of the same line' : (o.no_vig_source || null),
      push_probability: num(c.fair.push_probability) || 0,
      fair_selection_line: num(c.fair.fair_line), sigma: num(c.fair.sigma), fair_line_se: num(o.fair_line_se),
      lower_bound: num(o.lower_bound), lower_bound_basis: o.lower_bound_basis || null,
      tier: tier, tier_basis: (c.fair.validation && c.fair.validation.basis) || (c.fair.validation && c.fair.validation.note) || null,
      calibration_available: o.calibration_available !== undefined ? o.calibration_available : (isDevig ? true : tier !== 'UNVALIDATED'),
      calibration_version: o.calibration_version || (c.fair.validation && c.fair.validation.model_generated_at) || null,
      model_version: (c.fair.validation && c.fair.validation.model_version) || (isDevig ? 'market_devig' : null),
      model_version_validated: isDevig ? null : (tier === 'VALIDATED' || tier === 'LEAN'),
      distribution_validated: isDevig ? null : (num(c.fair.sigma) != null && tier !== 'RESEARCH'),
      sample_n: num(o.sample_n), data_completeness: num(c.completeness) != null ? num(c.completeness) : num(o.data_completeness),
      book_families: num(o.book_families),
      /* the decision layer's own confirmation verdict, carried rather than
         recomputed; null for a method that does not run one */
      book_confirmed: c.decision && c.decision.gates && typeof c.decision.gates.confirmation === 'boolean' ? c.decision.gates.confirmation : null,
      book_disagreement: o.book_disagreement || null,
      availability_state: o.availability_state || null, availability_unresolved: o.availability_unresolved === true, availability_note: o.availability_note || null,
      inferred_inputs: o.inferred_inputs === true, inferred_note: o.inferred_note || null,
      market_definition_mismatch: mismatch,
      price_limit_american: c.threshold && c.threshold.kind === 'price' ? num(c.threshold.price_limit_american) : null,
      bet_to_line: c.threshold && c.threshold.kind === 'line' ? num(c.threshold.bet_to_line) : null,
      counter: c.counter || null,
      invalidation: (c.would_change || []).slice(0, 6),
      primary_reason: (c.reasons && c.reasons.length ? c.reasons[0].text : null),
      reasons: c.reasons || [], outlier: c.outlier || null,
      research_reason: c.outlier ? c.outlier : null,
      qualification: c.qualification || null, sig_key: c.sig_key || null, evidence_packet_id: c.evidence_packet_id || null,
      warnings: c.outlier ? ['DATA_CHECK: ' + c.outlier] : []
    };
  }

  /* ==================================================================== */
  /* 11. BEST-MARKET SELECTION                                            */
  /* ==================================================================== */
  /**
   * The six candidates of one game, compared on CONSERVATIVE expected value
   * after uncertainty and the caps — never on raw model disagreement.
   *
   * Returns the comparison table, the PRIMARY market, and a SECONDARY only
   * when it independently qualifies and the game cap still holds.
   */
  function bestMarket(recs, o) {
    o = o || {};
    var S = o.settings || settings(null, {});
    var rows = (recs || []).map(function (r) {
      return { id: r.id, market: r.market, market_key: r.market_key, selection: r.selection, side: r.side || null, line: r.line, american_odds: r.american_odds, sportsbook: r.sportsbook, status: r.status, expected_value: r.expected_value, conservative_probability: r.conservative_probability, recommended_units: r.recommended_units, recommendation_tier: r.recommendation_tier, reliability_score: r.reliability_score, why: r.primary_reason, gates_failed: (r.gates_failed || []).map(function (g) { return g.code; }) };
    });
    /* the ranking: conservative EV after uncertainty and the caps. A wager the
       caps refused cannot outrank one they allowed, whatever its arithmetic. */
    var ranked = rows.slice().sort(function (a, b) {
      var au = num(a.recommended_units) || 0, bu = num(b.recommended_units) || 0;
      if ((au > 0) !== (bu > 0)) return bu - au;
      var ae = num(a.expected_value), be = num(b.expected_value);
      return (be == null ? -99 : be) - (ae == null ? -99 : ae);
    });
    var primary = ranked.filter(function (r) { return r.recommended_units > 0; })[0] || null;
    var secondary = null, secondaryWhy = null;
    if (primary && S.allow_second_market_per_game) {
      var others = ranked.filter(function (r) { return r.id !== primary.id && r.recommended_units > 0; });
      /* never the other side of the same market: it cannot also win */
      others = others.filter(function (r) { return r.market_key !== primary.market_key; });
      if (others.length) {
        var cand = others[0];
        var combined = r2(num(primary.recommended_units) + num(cand.recommended_units));
        if (combined <= num(S.maximum_game_exposure_units) + 1e-9) { secondary = cand; secondaryWhy = 'a second market on this game is recommended because it qualified on its own numbers and the combined ' + fmtUnits(combined) + ' is inside the ' + S.maximum_game_exposure_units + 'u game cap'; }
        else secondaryWhy = 'a second market qualified (' + cand.selection + ' ' + cand.market + ', ' + fmtUnits(cand.recommended_units) + ') but the combined ' + fmtUnits(combined) + ' would breach the ' + S.maximum_game_exposure_units + 'u game cap, so only the primary is recommended';
      } else secondaryWhy = 'no second market on this game qualified on its own, so none is added: a side and a total are not automatically recommended together';
    }
    return {
      schema: 'edgedesk_best_market_v1', game_id: rows.length ? recs[0].event_id : null, matchup: rows.length ? recs[0].matchup : null,
      compared: rows.length, table: ranked, primary: primary, secondary: secondary, secondary_why: secondaryWhy,
      basis: 'ranked by conservative expected value at the executable price after uncertainty and the exposure caps; a raw model disagreement never orders this table',
      none_why: primary ? null : 'no market in this game produced a positive conservative expected value at an executable price, so the answer for the game is PASS'
    };
  }

  /* ==================================================================== */
  /* 12. ALTERNATE LINES                                                  */
  /* ==================================================================== */
  /**
   * Compare the main number against captured alternates for the same side.
   *
   * Only a CAPTURED, EXECUTABLE quote at the alternate number counts: moving
   * along a cover curve to a number nobody is offering is arithmetic, and
   * presenting it as a bet is the mistake this function exists to prevent.
   */
  function alternates(rec, list, o) {
    o = o || {};
    var S = o.settings || settings(null, {});
    var base = rec;
    var out = [];
    (list || []).forEach(function (alt) {
      if (!alt || num(alt.line) == null || num(alt.american_odds) == null) return;
      if (num(alt.line) === num(base.line) && num(alt.american_odds) === num(base.american_odds)) return;
      var r = alt.recommendation || null;
      if (!r) return;
      out.push({
        line: r.line, american_odds: r.american_odds, sportsbook: r.sportsbook,
        price_difference: base.american_odds != null && r.american_odds != null ? r2(r.american_odds - base.american_odds) : null,
        probability_difference: base.conservative_probability != null && r.conservative_probability != null ? r4(r.conservative_probability - base.conservative_probability) : null,
        ev_difference: base.expected_value != null && r.expected_value != null ? r4(r.expected_value - base.expected_value) : null,
        units: r.recommended_units, status: r.status,
        preferred: r.expected_value != null && base.expected_value != null && r.expected_value > base.expected_value && r.recommended_units > 0,
        why: r.expected_value == null || base.expected_value == null ? 'not comparable: one of the two has no expected value'
          : r.expected_value > base.expected_value ? 'the alternate number returns ' + pp(r.expected_value - base.expected_value, 2) + ' more per unit at the price actually captured for it, and it is an executable quote rather than a point on a curve'
            : 'the main number is better: the alternate gives up ' + pp(base.expected_value - r.expected_value, 2) + ' per unit'
      });
    });
    if (!out.length) return null;
    out.sort(function (a, b) { return (num(b.ev_difference) || -99) - (num(a.ev_difference) || -99); });
    return { main: { line: base.line, american_odds: base.american_odds, sportsbook: base.sportsbook, expected_value: base.expected_value, conservative_probability: base.conservative_probability, units: base.recommended_units }, alternates: out, preferred: out.filter(function (x) { return x.preferred; })[0] || null, note: 'Only captured, executable quotes at the alternate number are compared. A number no book is offering is not an alternative.' };
  }

  /* ==================================================================== */
  /* 13. THE CARD                                                         */
  /*                                                                      */
  /* The whole slate before any stake, because a recommendation sized in   */
  /* isolation is how a card ends up with 3 units on one quarterback.      */
  /* ==================================================================== */
  /**
   * o.candidates   normalised candidates (candidateFromBoard / your own)
   * o.settings     the policy
   * o.positions    already-pending or submitted positions
   * o.timezone     the reader's zone, for the day and week keys
   * o.ask          what the question asked for (classifyAsk)
   * o.top          how many recommendations to emit
   * o.parlay       { requested, legs_wanted, combined_american }
   */
  function buildCard(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var S = o.settings || settings(o.settings_row || null, o.policy_over || {});
    var tz = o.timezone || null;
    var ask = o.ask || classifyAsk(o.question || '');
    var cands = (o.candidates || []).filter(Boolean);
    var opening = exposureLedger({ positions: o.positions || [], timezone: tz });
    /* PASS 1 — every candidate against the OPENING ledger, so the ranking is
       not an artifact of the order the sizes were applied in. */
    var evaluated = cands.map(function (c) { return evaluate(c, { settings: S, ledger: opening, timezone: tz, now: now }); });
    /* the per-game comparison, from the pass-1 numbers */
    var byGame = {};
    evaluated.forEach(function (r) { var k = r.sport + '|' + r.event_id; (byGame[k] = byGame[k] || []).push(r); });
    var games = Object.keys(byGame).map(function (k) { return bestMarket(byGame[k], { settings: S }); });
    /* PASS 2 — commit in ranked order against a LIVE ledger, so each accepted
       recommendation is visible to the next one's caps. */
    var order = evaluated.slice().sort(function (a, b) {
      var au = num(a.recommended_units) || 0, bu = num(b.recommended_units) || 0;
      if ((au > 0) !== (bu > 0)) return bu - au;
      var ae = num(a.expected_value), be = num(b.expected_value);
      if ((be == null ? -99 : be) !== (ae == null ? -99 : ae)) return (be == null ? -99 : be) - (ae == null ? -99 : ae);
      return (toMs(a.kickoff) || 0) - (toMs(b.kickoff) || 0);
    });
    var ledger = opening;
    var recommended = [], watch = [], passed = [], research = [], portfolio = [], perGame = {}, perGameUnits = {};
    var top = num(o.top) || 5;
    order.forEach(function (first) {
      var c = cands.filter(function (x) { return (x.id || '') === first.id; })[0] || null;
      var gk = first.sport + '|' + first.event_id;
      /* re-evaluate against the live ledger: the caps have moved */
      var r = c ? evaluate(c, { settings: S, ledger: ledger, timezone: tz, now: now }) : first;
      var corr = r.correlated_exposure || [];
      var dup = corr.filter(function (x) { return x.kind === 'DUPLICATE_SELECTION' || x.kind === 'OPPOSING_POSITION'; })[0] || null;
      if (r.status === 'RESEARCH_ONLY') { research.push(r); return; }
      if (dup) {
        r.status = 'PASS'; r.recommended_units = 0; r.recommended_dollars = null; r.recommendation_tier = 'PASS';
        r.portfolio_reason = dup.kind === 'DUPLICATE_SELECTION' ? 'the same selection is already on the card; the lower-EV duplicate is removed rather than stacked' : 'the other side of this market is already on the card; two opposing positions are not diversification';
        portfolio.push({ kind: dup.kind, selection: r.selection, with: dup.with, action: 'REMOVED', why: r.portfolio_reason });
        passed.push(r); return;
      }
      if (r.recommended_units > 0 && perGame[gk] && !(S.allow_second_market_per_game && perGame[gk] !== r.market_key && r2((perGameUnits[gk] || 0) + r.recommended_units) <= num(S.maximum_game_exposure_units) + 1e-9)) {
        r.status = 'PASS'; r.recommended_units = 0; r.recommended_dollars = null; r.recommendation_tier = 'PASS';
        r.portfolio_reason = 'a higher-ranked market in this game is already recommended; one primary market per game unless a second qualifies independently inside the game cap';
        portfolio.push({ kind: 'SECOND_MARKET_SAME_GAME', selection: r.selection, with: perGame[gk], action: 'HELD', why: r.portfolio_reason });
        passed.push(r); return;
      }
      /* THE EMIT LIMIT IS A COMMIT LIMIT.
         Trimming the ranked list after the ledger had already absorbed every
         position left the card reporting exposure it was not recommending —
         the caps and the printed "exposure after" disagreed with the answer.
         A position past the limit is never committed, so the ledger and the
         card say the same thing. */
      if (r.recommended_units > 0 && recommended.length >= top) {
        r.status = 'PASS'; r.recommended_units = 0; r.recommended_dollars = null; r.recommendation_tier = 'PASS';
        r.portfolio_reason = 'ranked below the ' + top + ' positions this card emits';
        passed.push(r); return;
      }
      if (r.recommended_units > 0) {
        var sameGameCorr = corr.filter(function (x) { return x.kind === 'SAME_GAME' || x.kind === 'SHARED_TEAM'; });
        if (sameGameCorr.length) r.warnings = uniq((r.warnings || []).concat(['CORRELATED: ' + sameGameCorr.map(function (x) { return x.kind + ' with ' + x.with; }).join('; ') + '. These are not independent tickets and are not counted as diversification.']));
        r.rank = recommended.length + 1;
        r.primary_for_game = !perGame[gk];
        recommended.push(r);
        perGame[gk] = r.market_key; perGameUnits[gk] = r2((perGameUnits[gk] || 0) + r.recommended_units);
        ledger = addToLedger(ledger, { sport: r.sport, game_id: r.event_id, market: r.market_key, side: r.side, selection: r.selection, line: r.line, kickoff: r.kickoff, home: r.home, away: r.away, teams: r.exposure_keys ? r.exposure_keys.teams : null }, r.recommended_units, 'SINGLE', tz);
        return;
      }
      if (r.status === 'WATCH') watch.push(r); else passed.push(r);
    });
    var emitted = recommended;
    var closing = ledger;
    var par = buildParlay({ settings: S, ask: ask, candidates: cands, evaluated: order, recommended: emitted, ledger: closing, timezone: tz, now: now, parlay: o.parlay || null });
    var strongestResearch = (watch.concat(passed).concat(research)).slice().sort(function (a, b) { return (num(b.expected_value) == null ? -99 : num(b.expected_value)) - (num(a.expected_value) == null ? -99 : num(a.expected_value)); })[0] || null;
    var card = {
      schema: CARD_SCHEMA, version: VERSION, built_at: new Date(now).toISOString(),
      question: str(o.question).slice(0, 300), ask: ask,
      policy: S, timezone: tz,
      markets_evaluated: evaluated.length, games_evaluated: games.length,
      recommendations: emitted, watchlist: watch.slice(0, Math.max(3, top)),
      /* A board sweep can evaluate hundreds of markets and every pass is a
         real result, so the passes are ORDERED BY EXPECTED VALUE and bounded
         rather than truncated arbitrarily: the ones a reader (or a grader)
         would ask about are the ones nearest to qualifying. The count of
         everything evaluated is `markets_evaluated`, which is never trimmed. */
      passes: passed.slice().sort(function (a, b) { return (num(b.expected_value) == null ? -99 : num(b.expected_value)) - (num(a.expected_value) == null ? -99 : num(a.expected_value)); }).slice(0, PASS_LIMIT),
      research_only: research.slice().sort(function (a, b) { return (num(b.expected_value) == null ? -99 : num(b.expected_value)) - (num(a.expected_value) == null ? -99 : num(a.expected_value)); }).slice(0, PASS_LIMIT),
      passes_total: passed.length, research_only_total: research.length,
      games: games, portfolio_actions: portfolio,
      exposure_before: { by_game: opening.by_game, by_team: opening.by_team, by_day: opening.by_day, by_week: opening.by_week, total_units: opening.total_units },
      exposure_after: { by_game: closing.by_game, by_team: closing.by_team, by_day: closing.by_day, by_week: closing.by_week, total_units: closing.total_units },
      exposure_ledger: closing,
      caps: { single: S.maximum_single_wager_units, game: S.maximum_game_exposure_units, team: S.maximum_team_exposure_units, daily: S.maximum_daily_exposure_units, weekly: S.maximum_weekly_exposure_units },
      total_recommended_units: r2(emitted.reduce(function (s, r) { return s + (num(r.recommended_units) || 0); }, 0)),
      total_recommended_dollars: emitted.every(function (r) { return r.recommended_dollars != null; }) && emitted.length ? r2(emitted.reduce(function (s, r) { return s + num(r.recommended_dollars); }, 0)) : null,
      parlay: par,
      strongest_research_candidate: strongestResearch ? { selection: strongestResearch.selection, matchup: strongestResearch.matchup, market: strongestResearch.market, line: strongestResearch.line, american_odds: strongestResearch.american_odds, expected_value: strongestResearch.expected_value, status: strongestResearch.status, why_not: (strongestResearch.gates_failed || []).map(function (g) { return g.detail || g.why; })[0] || strongestResearch.portfolio_reason || 'no gate recorded' } : null,
      no_forced_pick: 'Nothing on this card is forced. PASS is a successful, normal result and is reported as one.',
      conviction_note: 'A reader’s conviction is context, never an input: it does not change a probability, an expected value or a unit size. Rivalry, revenge, atmosphere, rankings and narrative are not model inputs and cannot raise a stake.',
      note: 'Every probability, price and size above was computed by EdgeDesk from stored records under the printed policy. The language model may explain this card; it may not change a number in it.'
    };
    card.headline = headlineFor(card);
    card.id = 'card_' + fnv1a(card.built_at + '|' + emitted.map(function (r) { return r.recommendation_id; }).join(',') + '|' + card.markets_evaluated);
    return card;
  }
  function headlineFor(card) {
    var n = card.recommendations.length;
    if (!card.markets_evaluated) return 'EdgeDesk evaluated no markets: nothing on the board could be priced to a stake.';
    if (!n) {
      var sr = card.strongest_research_candidate;
      return 'NO BET. EdgeDesk evaluated ' + card.markets_evaluated + ' current market' + (card.markets_evaluated === 1 ? '' : 's') + ' and none produced positive conservative expected value after uncertainty, price freshness and existing exposure.'
        + (sr ? ' The strongest research candidate was ' + sr.selection + (sr.line != null ? ' ' + (sr.market === 'total' ? sr.line : fmtLine(sr.line)) : '') + ', and it failed because ' + sr.why_not + '.' : '');
    }
    return n + ' recommended position' + (n === 1 ? '' : 's') + ' totalling ' + fmtUnits(card.total_recommended_units) + (card.total_recommended_dollars != null ? ' (' + fmtMoney(card.total_recommended_dollars) + ')' : '') + ' from ' + card.markets_evaluated + ' market' + (card.markets_evaluated === 1 ? '' : 's') + ' evaluated across ' + card.games_evaluated + ' game' + (card.games_evaluated === 1 ? '' : 's') + '.';
  }

  /* ==================================================================== */
  /* 14. THE PARLAY                                                       */
  /*                                                                      */
  /* Separate from the card, off unless asked for, and never given a       */
  /* combined probability: EdgeDesk does not treat legs as independent and */
  /* has no method that would justify multiplying them.                   */
  /* ==================================================================== */
  function buildParlay(o) {
    o = o || {};
    var S = o.settings, ask = o.ask || {}, req = o.parlay || {};
    var wanted = req.requested === true || ask.parlay === true;
    if (!wanted && !S.parlays_allowed) return { schema: PARLAY_SCHEMA, requested: false, built: false, why: 'No parlay was requested and parlays are not enabled in your settings, so none was constructed. EdgeDesk prefers singles.' };
    if (!S.parlays_allowed && wanted !== true) return { schema: PARLAY_SCHEMA, requested: false, built: false, why: 'Parlays are disabled in your settings.' };
    var recIds = {}; (o.recommended || []).forEach(function (r) { recIds[r.id] = 1; });
    var recTeams = {}; (o.recommended || []).forEach(function (r) { ((r.exposure_keys && r.exposure_keys.teams) || []).forEach(function (t) { recTeams[t] = 1; }); });
    var pool = (o.evaluated || []).filter(function (r) {
      if (recIds[r.id]) return false;                       /* already a single */
      if (r.expected_value == null || r.expected_value <= 0) return false; /* every leg positive on its own */
      if ((r.gates_failed || []).some(function (g) { return g.status === 'RESEARCH_ONLY'; })) return false;
      return true;
    });
    var legs = [], usedTeams = {}, usedGames = {};
    pool.sort(function (a, b) { return num(b.expected_value) - num(a.expected_value); }).forEach(function (r) {
      if (legs.length >= num(S.maximum_parlay_legs)) return;
      var teams = (r.exposure_keys && r.exposure_keys.teams) || [];
      if (teams.some(function (t) { return usedTeams[t] || recTeams[t]; })) return;   /* no team twice, and none from the singles */
      var gk = r.sport + '|' + r.event_id;
      if (usedGames[gk]) return;                                                     /* correlated legs are not legs */
      legs.push(r); teams.forEach(function (t) { usedTeams[t] = 1; }); usedGames[gk] = 1;
    });
    if (legs.length < 2) return { schema: PARLAY_SCHEMA, requested: true, built: false, legs: legs.length, why: 'A parlay needs at least two legs that each clear every gate on their own, are not already recommended as singles, and share no team with the card. ' + (pool.length ? 'Only ' + legs.length + ' of ' + pool.length + ' positive-EV candidates survived those rules.' : 'No candidate cleared them.') };
    var combined = num(req.combined_american);
    if (combined == null) return { schema: PARLAY_SCHEMA, requested: true, built: false, legs: legs.length, candidate_legs: legs.map(legSummary), why: 'The legs exist, but no verified combined price is on file. EdgeDesk will not multiply the leg prices to invent one, so the parlay is not priced or sized. Supply the book’s own combined price and it will be evaluated.' };
    /* the stake: the minimum, rising only when every leg is a STRONG or MAX single */
    var allStrong = legs.every(function (r) { return r.recommendation_tier === 'STRONG' || r.recommendation_tier === 'MAX MODEL POSITION'; });
    var stake = allStrong ? num(S.maximum_parlay_stake_units) : num(S.minimum_parlay_stake_units);
    stake = Math.min(stake, num(S.maximum_parlay_stake_units));
    return {
      schema: PARLAY_SCHEMA, requested: true, built: true, legs: legs.length, leg_detail: legs.map(legSummary),
      combined_american: combined, combined_decimal: r4(amToDec(combined)), combined_price_source: str(req.combined_price_source || 'supplied with the request and taken as the book’s own number'),
      stake_units: r2(stake), stake_dollars: S.dollars_exact && num(S.base_unit_amount) != null ? r2(stake * num(S.base_unit_amount)) : null,
      stake_basis: allStrong ? 'every leg is a STRONG or MAX single on its own, so the stake is the policy maximum of ' + S.maximum_parlay_stake_units + 'u' : 'at least one leg is below STRONG, so the stake is the policy minimum of ' + S.minimum_parlay_stake_units + 'u',
      no_combined_probability: 'EdgeDesk states NO combined probability and NO parlay expected value. The legs are not independent events, no validated method for their joint distribution exists here, and multiplying the leg probabilities would manufacture one.',
      rules_applied: ['every leg clears every single-wager gate on its own', 'no leg is already recommended as a single', 'no team is reused across the card or inside the parlay', 'one leg per game', 'at most ' + S.maximum_parlay_legs + ' legs', 'the combined price is the book’s, verified, never multiplied out', 'the stake is between ' + S.minimum_parlay_stake_units + 'u and ' + S.maximum_parlay_stake_units + 'u and counts against every exposure cap'],
      why: 'Constructed because it was asked for and every rule above held. A parlay is never built to make a payout larger.'
    };
  }
  function legSummary(r) { return { id: r.id, sport: r.sport, matchup: r.matchup, market: r.market, selection: r.selection, line: r.line, american_odds: r.american_odds, sportsbook: r.sportsbook, conservative_probability: r.conservative_probability, expected_value: r.expected_value, units_as_single: r.recommended_units, tier: r.recommendation_tier }; }

  /* ==================================================================== */
  /* 15. THE ASK                                                          */
  /* ==================================================================== */
  /** Does this question want a stake, and which kind? Words only; no state. */
  function classifyAsk(q) {
    var s = str(q).toLowerCase();
    var out = { kinds: [], units: false, card: false, parlay: /\bparlay\b/.test(s), conviction: false, game_only: false, wants_stake: false };
    if (/\bhow many units\b|\bunit size\b|\bhow (much|many)\b.{0,24}\b(bet|risk|stake|put|play|wager)\b|\bwhat (size|stake)\b|\bsize (it|this|that)\b|\bhow much (should|would) i\b/.test(s)) { out.kinds.push('units'); out.units = true; }
    if (/\bbuild (my|me|a) card\b|\bmy card\b|\bbuild the card\b|\bwhat'?s my card\b/.test(s)) { out.kinds.push('build_card'); out.card = true; }
    if (/\bbest bets?\b|\bstrongest\b|\btop (bet|bets|play|plays)\b|\brank\b.{0,30}\b(bet|bets|opportunit|edge|play)\b|\bwhat should i bet\b|\bmost mispriced\b|\bbiggest edge\b/.test(s)) { out.kinds.push('best_bets'); }
    if (/\b(spread|moneyline|money line|ml|total)\b.{0,30}\bor\b.{0,30}\b(spread|moneyline|money line|ml|total)\b|\bwhich (is|one is) better\b|\bwhich market\b|\bbetter (bet|value)\b.{0,20}\b(spread|moneyline|total)\b/.test(s)) { out.kinds.push('market_choice'); }
    if (/\b(over|under)\b.{0,12}\bor\b.{0,12}\b(over|under)\b|\bshould i (bet|take|play) the (over|under)\b|\bover or under\b/.test(s)) { out.kinds.push('over_under'); }
    if (/\bbest bet\b.{0,24}\b(in|for|on)\b.{0,24}\b(this|that|the)\b.{0,12}\bgame\b|\bbest bet here\b|\bbest bet in this\b/.test(s)) { out.kinds.push('best_in_game'); out.game_only = true; }
    if (/\bmost mispriced\b|\bmispriced\b/.test(s)) out.kinds.push('mispriced');
    if (/\b(a lot of |high |strong |big |lots of )?conviction\b|\bi (really )?(love|like|hammer|am all over)\b|\bi'?m confident\b|\bgut\b|\block it in\b/.test(s)) out.conviction = true;
    out.kinds = uniq(out.kinds);
    out.wants_stake = out.kinds.length > 0 || out.units || out.card;
    out.kind = out.kinds[0] || null;
    return out;
  }
  /** The router the host calls: does this turn need the staking engine? */
  function wantsStake(q) { return classifyAsk(q).wants_stake; }

  /* ==================================================================== */
  /* 16. THE DETERMINISTIC ANSWER                                         */
  /*                                                                      */
  /* Printed by EdgeDesk, not written by a model. It is what the reader    */
  /* sees when the prose is rejected, and it is the shape the prose is     */
  /* asked to follow.                                                     */
  /* ==================================================================== */
  function recLines(r, o) {
    o = o || {};
    var L = [];
    var lineTxt = r.line == null ? '' : (r.market === 'total' ? ' ' + r.line : ' ' + fmtLine(r.line));
    L.push((o.index != null ? (o.index + 1) + '. ' : '') + 'Selection: ' + r.selection + lineTxt + (r.market === 'moneyline' ? ' ML' : ''));
    L.push('Best price: ' + fmtAm(r.american_odds) + (r.sportsbook ? ' at ' + r.sportsbook : '') + (r.price_captured_at ? ' (captured ' + r.price_captured_at + ', ' + r.price_freshness + (r.price_age_seconds != null ? ', ' + Math.round(r.price_age_seconds / 60) + ' min ago' : '') + ')' : ''));
    if (r.fair_line != null) L.push('EdgeDesk fair line: ' + (r.market === 'total' ? r.fair_line : fmtLine(r.fair_line)));
    L.push('Calibrated probability: ' + pct(r.calibrated_probability) + (r.model_probability != null && r.model_probability !== r.calibrated_probability ? ' (raw model ' + pct(r.model_probability) + ')' : ''));
    L.push('Conservative staking probability: ' + pct(r.conservative_probability) + ' [' + r.conservative_method + ']');
    L.push('No-vig market probability: ' + (r.no_vig_market_probability == null ? 'not computable — ' + str(r.no_vig_source) : pct(r.no_vig_market_probability)));
    L.push('Conservative EV: ' + pp(r.expected_value, 1) + ' per unit (fair odds ' + fmtAm(r.fair_odds) + ', break-even ' + pct(r.break_even_probability) + ')');
    L.push('Reliability: ' + r.reliability_score + (r.reliability_components && r.reliability_components.length ? ' (weakest: ' + r.reliability_components.slice().sort(function (a, b) { return a.value - b.value; })[0].name + ')' : ''));
    L.push('Recommended position: ' + r.recommendation_label + (r.recommended_dollars != null ? ' / ' + fmtMoney(r.recommended_dollars) : '') + ' [' + (r.kelly_basis || 'Kelly') + '; ' + (r.rounding ? r.rounding.why : 'rounded down') + ']');
    L.push('Exposure after this wager: ' + fmtUnits(r.resulting_team_exposure_units) + ' on ' + (r.exposure_keys && (r.exposure_keys.team_label || r.exposure_keys.team) ? (r.exposure_keys.team_label || r.exposure_keys.team) : 'this team') + ' (cap ' + r.policy.max_team + 'u), ' + fmtUnits(r.resulting_game_exposure_units) + ' on the game (cap ' + r.policy.max_game + 'u), ' + fmtUnits(r.resulting_daily_exposure_units) + ' for the day (cap ' + r.policy.max_daily + 'u), ' + fmtUnits(r.resulting_weekly_exposure_units) + ' for the week (cap ' + r.policy.max_weekly + 'u)');
    if (r.price_limit_american != null) L.push('Playable through: ' + fmtAm(r.price_limit_american) + ' at ' + (r.market === 'total' ? r.line : fmtLine(r.line)));
    else if (r.bet_to_line != null) L.push('Playable through: ' + (r.market === 'total' ? r.bet_to_line : fmtLine(r.bet_to_line)) + ' (bet-to number)');
    L.push('Why: ' + r.primary_reason);
    L.push('Main risk: ' + r.strongest_counterargument);
    if (r.invalidation_conditions && r.invalidation_conditions.length) L.push('Invalidated by: ' + r.invalidation_conditions.slice(0, 3).join(' '));
    if (r.correlated_exposure && r.correlated_exposure.length) L.push('Correlated with: ' + r.correlated_exposure.map(function (c) { return c.kind + ' — ' + c.with; }).join('; '));
    if (r.cap_trimmed_note) L.push('Size reduced by a cap: ' + r.cap_trimmed_note);
    else if (r.binding_cap) L.push('Binding cap: ' + r.binding_cap + ' — ' + (r.caps_applied.filter(function (c) { return c.code === r.binding_cap; })[0] || {}).why);
    if (r.warnings && r.warnings.length) L.push('Warnings: ' + r.warnings.join(' | '));
    L.push('Status: ' + r.status);
    return L;
  }
  function render(card) {
    if (!card) return '';
    var L = [];
    if (!card.recommendations.length) {
      L.push('NO BET');
      L.push('');
      /* the headline is self-describing for the prompt block, so the prefix it
         carries there is dropped here rather than printed twice */
      L.push(str(card.headline).replace(/^NO BET\.\s*/, ''));
      if (card.watchlist.length) { L.push(''); L.push('Watchlist — positive expected value the size rules refused, with what would change it:'); card.watchlist.forEach(function (r) { L.push('• ' + r.selection + (r.line == null ? '' : ' ' + (r.market === 'total' ? r.line : fmtLine(r.line))) + ' ' + fmtAm(r.american_odds) + ' — ' + r.matchup + ': ' + pp(r.expected_value, 1) + ' conservative EV, 0u because ' + ((r.gates_failed || []).map(function (g) { return g.detail || g.why; })[0] || 'the size rounded below the minimum')); }); }
      if (card.research_only.length) { L.push(''); L.push('Research only (EdgeDesk cannot price these to a stake): ' + card.research_only.slice(0, 5).map(function (r) { return r.selection + ' (' + ((r.gates_failed || [])[0] || {}).code + ')'; }).join(', ')); }
      L.push('');
      L.push('PASS is a successful result. ' + card.policy.basis);
      return L.join('\n');
    }
    L.push(card.recommendations.length === 1 ? 'BEST BET' : 'THE CARD');
    L.push('');
    card.recommendations.forEach(function (r, i) { L = L.concat(recLines(r, { index: card.recommendations.length > 1 ? i : null })); L.push(''); });
    L.push('Card total: ' + fmtUnits(card.total_recommended_units) + (card.total_recommended_dollars != null ? ' / ' + fmtMoney(card.total_recommended_dollars) : '') + ' across ' + card.recommendations.length + ' position' + (card.recommendations.length === 1 ? '' : 's') + '. Daily cap ' + card.caps.daily + 'u, weekly cap ' + card.caps.weekly + 'u.');
    if (card.portfolio_actions.length) L.push('Portfolio: ' + card.portfolio_actions.map(function (a) { return a.action + ' ' + a.selection + ' — ' + a.why; }).join(' | '));
    if (card.watchlist.length) L.push('Watchlist: ' + card.watchlist.map(function (r) { return r.selection + ' ' + fmtAm(r.american_odds) + ' (' + pp(r.expected_value, 1) + ', 0u)'; }).join('; '));
    if (card.parlay && card.parlay.built) L.push('Parlay (separate from the card): ' + card.parlay.legs + ' legs at a verified ' + fmtAm(card.parlay.combined_american) + ', stake ' + fmtUnits(card.parlay.stake_units) + '. ' + card.parlay.no_combined_probability);
    else if (card.parlay && card.parlay.requested) L.push('Parlay: not constructed — ' + card.parlay.why);
    if (!card.policy.bankroll_known) L.push('Bankroll: ' + card.policy.dollars_note);
    L.push(card.note);
    return L.join('\n');
  }

  /* ==================================================================== */
  /* 17. THE PROMPT BLOCK AND THE CRITIC                                  */
  /* ==================================================================== */
  function promptBlock(card) {
    if (!card) return '';
    var L = [];
    L.push('STAKING (' + card.schema + ') — EdgeDesk’s own position sizes, computed by code from stored records. THIS BLOCK IS THE ANSWER. You may explain it; you may NOT change a selection, a probability, a price, an expected value, a unit size or a status, and you may not add one that is not here.');
    L.push('HEADLINE: ' + card.headline);
    L.push('POLICY: ' + card.policy.basis + ' Bankroll on file: ' + (card.policy.bankroll_known ? 'yes' : 'NO — ' + card.policy.dollars_note) + ' Base unit: ' + fmtMoney(card.policy.base_unit_amount) + ' (' + card.policy.sources.base_unit_amount + ').');
    L.push('EVALUATED: ' + card.markets_evaluated + ' market(s) across ' + card.games_evaluated + ' game(s); ' + card.recommendations.length + ' recommended, ' + card.watchlist.length + ' watched, ' + card.passes.length + ' passed, ' + card.research_only.length + ' research only.');
    if (card.recommendations.length) {
      L.push('RECOMMENDED POSITIONS (print every field; the units and dollars are final):');
      card.recommendations.forEach(function (r, i) { L.push(recLines(r, { index: i }).map(function (x) { return '  ' + x; }).join('\n')); });
    } else {
      L.push('NO QUALIFYING OPPORTUNITY. Write the NO BET answer: say how many markets were evaluated, that none produced positive conservative EV after uncertainty, price freshness and existing exposure, and name the strongest research candidate with the SPECIFIC reason it failed. Do not hide the pass behind vague wording and do not offer a smaller bet instead.');
      if (card.strongest_research_candidate) L.push('  STRONGEST RESEARCH CANDIDATE: ' + card.strongest_research_candidate.selection + ' ' + (card.strongest_research_candidate.line == null ? '' : card.strongest_research_candidate.line) + ' ' + fmtAm(card.strongest_research_candidate.american_odds) + ' — failed because ' + card.strongest_research_candidate.why_not);
    }
    if (card.watchlist.length) { L.push('WATCHLIST (positive EV, 0 units — never call these bets):'); card.watchlist.forEach(function (r) { L.push('  ' + r.selection + ' ' + fmtAm(r.american_odds) + ': ' + pp(r.expected_value, 1) + ' conservative EV, 0u because ' + ((r.gates_failed || []).map(function (g) { return g.detail || g.why; })[0] || 'the rounding floor')); }); }
    if (card.games.length && card.games.length <= 4) { L.push('MARKET COMPARISON PER GAME (why this market and not the others):'); card.games.forEach(function (g) { L.push('  ' + (g.matchup || g.game_id) + ': ' + g.table.map(function (t) { return t.selection + ' ' + t.market + ' ' + pp(t.expected_value, 1) + ' → ' + fmtUnits(t.recommended_units); }).join(' | ') + (g.secondary_why ? ' [' + g.secondary_why + ']' : '') + (g.none_why ? ' [' + g.none_why + ']' : '')); }); }
    if (card.portfolio_actions.length) { L.push('PORTFOLIO ACTIONS: ' + card.portfolio_actions.map(function (a) { return a.action + ' ' + a.selection + ' (' + a.kind + '): ' + a.why; }).join(' | ')); }
    L.push('EXPOSURE AFTER THE CARD: ' + JSON.stringify(card.exposure_after.by_team) + ' by team; ' + JSON.stringify(card.exposure_after.by_day) + ' by day; total ' + fmtUnits(card.exposure_after.total_units) + '. Caps: single ' + card.caps.single + 'u, game ' + card.caps.game + 'u, team ' + card.caps.team + 'u, daily ' + card.caps.daily + 'u, weekly ' + card.caps.weekly + 'u.');
    L.push('PARLAY: ' + (card.parlay && card.parlay.built ? card.parlay.legs + ' legs at a verified ' + fmtAm(card.parlay.combined_american) + ', stake ' + fmtUnits(card.parlay.stake_units) + '. ' + card.parlay.no_combined_probability : (card.parlay ? card.parlay.why : 'none')));
    L.push('RULES FOR YOUR PROSE: quote the unit size and the dollar figure exactly as printed; never compute or adjust either; never state a probability, price, EV, edge or unit size that is not in this block; never call a WATCH, a PASS or a research-only item a bet; never use certainty language; never state a combined parlay probability; never offer to raise a size for conviction — acknowledge the conviction in one clause and keep the calculated size; say "MAX MODEL POSITION means the largest size this policy allows, not certainty" if you use that tier. ' + card.conviction_note + ' ' + card.no_forced_pick);
    return L.join('\n');
  }
  /** Numbers and names the critic may allow from the card. */
  function allowedFrom(card) {
    var nums = [], names = [];
    function add(v) { var n = num(v); if (n != null) nums.push(n); }
    var all = (card.recommendations || []).concat(card.watchlist || [], card.passes || [], card.research_only || []);
    all.forEach(function (r) {
      add(r.line); add(r.american_odds); add(r.decimal_odds); add(r.model_probability); add(r.calibrated_probability); add(r.conservative_probability);
      add(r.no_vig_market_probability); add(r.model_edge); add(r.conservative_edge); add(r.expected_value); add(r.fair_odds); add(r.fair_decimal_odds); add(r.fair_line);
      add(r.reliability_score); add(r.raw_kelly_fraction); add(r.fractional_kelly_fraction); add(r.recommended_units); add(r.recommended_dollars);
      add(r.break_even_probability); add(r.existing_team_exposure_units); add(r.resulting_team_exposure_units); add(r.existing_game_exposure_units); add(r.resulting_game_exposure_units);
      add(r.existing_daily_exposure_units); add(r.resulting_daily_exposure_units); add(r.existing_weekly_exposure_units); add(r.resulting_weekly_exposure_units);
      add(r.price_limit_american); add(r.bet_to_line); add(r.price_age_seconds);
      names.push(r.selection, r.sportsbook, r.home, r.away);
    });
    add(card.total_recommended_units); add(card.total_recommended_dollars); add(card.markets_evaluated); add(card.games_evaluated);
    add(card.caps.single); add(card.caps.game); add(card.caps.team); add(card.caps.daily); add(card.caps.weekly);
    add(card.policy.base_unit_amount); add(card.policy.bankroll_amount); add(card.policy.fractional_kelly_multiplier);
    if (card.parlay && card.parlay.built) { add(card.parlay.combined_american); add(card.parlay.stake_units); add(card.parlay.stake_dollars); }
    return { numbers: uniq(nums), names: uniq(names.filter(Boolean)) };
  }
  var CERTAINTY = /\b(guarantee|guaranteed|can'?t (lose|miss)|lock|locks|lock of the|sure thing|free money|will (win|cover|cash)|mortal lock|no[- ]brainer|easy money)\b/i;
  /**
   * The checks a staking answer must survive. A FAIL replaces the prose with
   * render(); nothing here edits the prose.
   */
  function criticExtras(o) {
    o = o || {};
    var a = str(o.answer), card = o.card, issues = [];
    if (!card) return issues;
    var allowed = allowedFrom(card);
    var recNames = card.recommendations.map(function (r) { return normName(r.selection); });
    var recUnits = {}; card.recommendations.forEach(function (r) { recUnits[normName(r.selection)] = r.recommended_units; });
    /* 1. a unit size the card did not produce */
    var um, ure = /(\d+(?:\.\d+)?)\s*(?:units?|u)\b/gi;
    while ((um = ure.exec(a))) {
      var u = Number(um[1]);
      if (!Number.isFinite(u)) continue;
      var ok = allowed.numbers.some(function (n) { return Math.abs(n - u) < 1e-9; });
      if (!ok) issues.push({ code: 'STAKE_UNITS_INVENTED', severity: 'FAIL', detail: 'the answer states ' + u + ' units and no recommendation, cap or exposure figure on the card carries that number' });
    }
    /* 2. a dollar figure the card did not produce */
    var dm, dre = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
    while ((dm = dre.exec(a))) {
      var d = Number(String(dm[1]).replace(/,/g, ''));
      if (!Number.isFinite(d)) continue;
      if (!allowed.numbers.some(function (n) { return Math.abs(n - d) < 0.005; })) issues.push({ code: 'STAKE_DOLLARS_INVENTED', severity: 'FAIL', detail: 'the answer states $' + dm[1] + ' and the card produced no such figure' + (card.policy.bankroll_known ? '' : '; no bankroll is on file, so no dollar amount may be stated at all') });
    }
    /* 3. a dollar figure at all when there is no bankroll and no stored unit */
    if (!card.policy.dollars_exact && /\$\s?\d/.test(a)) issues.push({ code: 'STAKE_DOLLARS_WITHOUT_BANKROLL', severity: 'FAIL', detail: 'the answer states a dollar amount and no bankroll or stored base unit is on file; the recommendation is in units only' });
    /* 4. a bet recommended that the card did not recommend */
    var bm, bre = /\b(bet|play|take|hammer|fire on|back|put)\b\s+(?:the\s+)?([a-z][a-z .&'-]{2,40}?)(?:\s+[+-]?\d|\s+ml\b|\s+moneyline|\s+over|\s+under|[,.;!?]|$)/gi;
    while ((bm = bre.exec(a))) {
      var who = normName(bm[2]);
      if (!who || who.length < 3) continue;
      if (recNames.some(function (n) { return n === who || n.indexOf(who) >= 0 || who.indexOf(n) >= 0; })) continue;
      var onCard = (card.watchlist || []).concat(card.passes || [], card.research_only || []).some(function (r) { var s = normName(r.selection); return s && (s === who || s.indexOf(who) >= 0 || who.indexOf(s) >= 0); });
      if (onCard) issues.push({ code: 'STAKE_UNRECOMMENDED_SIZED', severity: 'FAIL', detail: 'the answer tells the reader to ' + bm[1] + ' "' + bm[2].trim() + '", which the engine passed or watched at 0 units' });
    }
    /* 5. a pick forced when nothing qualified */
    if (!card.recommendations.length && /\b(best bet is|my (top |best )?pick is|the play (here )?is|i(?:'d| would) (bet|take|play)|start with a small)\b/i.test(a)) issues.push({ code: 'STAKE_FORCED_PICK', severity: 'FAIL', detail: 'nothing qualified and the answer names or sizes a pick anyway' });
    /* 6. the PASS hidden */
    if (!card.recommendations.length && !/\bno bet\b|\bpass\b|\bnothing (qualifies|qualified)\b|\bnone (qualified|produced)\b/i.test(a)) issues.push({ code: 'STAKE_PASS_HIDDEN', severity: 'FAIL', detail: 'the card is a PASS and the answer never says so plainly' });
    /* 7. certainty */
    if (CERTAINTY.test(a)) issues.push({ code: 'STAKE_CERTAINTY', severity: 'FAIL', detail: 'certainty language over a sized research position' });
    /* 8. a combined parlay probability */
    if (/\bparlay\b/i.test(a) && /\b\d{1,2}(\.\d)?\s*%\s*(chance|probability|to hit|to cash)\b|\bcombined (probability|chance)\b/i.test(a)) issues.push({ code: 'STAKE_PARLAY_MULTIPLIED', severity: 'FAIL', detail: 'the answer states a combined parlay probability; EdgeDesk produces none because the legs are not independent' });
    /* 9. a size raised for conviction */
    if (/\b(since|because|given|as) you('?re| are)? (so )?(confident|sure|high on|all over)\b[^.]{0,80}\b(bump|raise|increase|go (up|bigger|heavier)|more units|full unit|max)\b/i.test(a)) issues.push({ code: 'STAKE_CONVICTION_UPSIZED', severity: 'FAIL', detail: 'the answer raises a size because the reader expressed conviction; conviction is not a model input' });
    /* 10. MAX presented as certainty */
    if (/\bmax model position\b/i.test(a) && /\b(certain|sure thing|our best ever|highest confidence bet)\b/i.test(a)) issues.push({ code: 'STAKE_MAX_AS_CERTAINTY', severity: 'FAIL', detail: 'MAX MODEL POSITION is the largest size the policy allows and must not be presented as certainty' });
    /* 11. an EV or probability not on the card */
    var pm, pre = /(\d{1,3}(?:\.\d{1,2})?)\s*%/g;
    while ((pm = pre.exec(a))) {
      var v = Number(pm[1]);
      if (!Number.isFinite(v)) continue;
      var hit = allowed.numbers.some(function (n) { return Math.abs(n * 100 - v) < 0.06 || Math.abs(n - v) < 0.06; });
      if (!hit) issues.push({ code: 'STAKE_NUMBER_NOT_ON_CARD', severity: 'WARN', detail: 'the answer states ' + pm[0] + ', which is not a probability, edge or expected value on the card' });
    }
    return issues;
  }

  /* ==================================================================== */
  /* 18. THE AUDIT TRAIL                                                  */
  /*                                                                      */
  /* One write-once row per recommendation, PASS included, with the        */
  /* snapshot of everything that produced it. The snapshot is never        */
  /* rewritten when the market moves: a later view is a later row.        */
  /* ==================================================================== */
  function records(card, extra) {
    extra = extra || {};
    var rows = [];
    var all = (card.recommendations || []).map(function (r) { return [r, 'RECOMMENDATION']; })
      .concat((card.watchlist || []).map(function (r) { return [r, 'WATCH']; }))
      .concat((card.passes || []).map(function (r) { return [r, 'PASS']; }))
      .concat((card.research_only || []).map(function (r) { return [r, 'RESEARCH_ONLY']; }));
    all.forEach(function (pair) {
      var r = pair[0], kind = pair[1];
      var snapshot = {
        schema: RECORD_SCHEMA, kind: kind, card_id: card.id, built_at: card.built_at, question: card.question, ask: card.ask,
        recommendation: r, policy: card.policy,
        exposure_before: { team: r.existing_team_exposure_units, game: r.existing_game_exposure_units, day: r.existing_daily_exposure_units, week: r.existing_weekly_exposure_units, keys: r.exposure_keys },
        exposure_after: { team: r.resulting_team_exposure_units, game: r.resulting_game_exposure_units, day: r.resulting_daily_exposure_units, week: r.resulting_weekly_exposure_units },
        caps: card.caps, caps_applied: r.caps_applied, binding_cap: r.binding_cap,
        reliability: { score: r.reliability_score, components: r.reliability_components, basis: r.reliability_basis },
        kelly: { raw: r.raw_kelly_fraction, fractional: r.fractional_kelly_fraction, multiplier: r.kelly_multiplier, stake_dollars: r.kelly_stake_dollars, raw_units: r.kelly_raw_units, basis: r.kelly_basis, rounding: r.rounding },
        gates_failed: r.gates_failed, pass_reason: r.status === 'BET' ? null : ((r.gates_failed || []).map(function (g) { return g.code + ': ' + (g.detail || g.why); })[0] || r.portfolio_reason || 'no gate fired and no size resulted'),
        correlated_exposure: r.correlated_exposure, portfolio_reason: r.portfolio_reason || null,
        alternates: r.alternates || null, parlay: kind === 'RECOMMENDATION' ? (card.parlay && card.parlay.built ? { legs: card.parlay.legs, combined_american: card.parlay.combined_american, stake_units: card.parlay.stake_units } : null) : null,
        immutable: 'This snapshot records what EdgeDesk said at this price at this time. It is never rewritten after the market moves; a later view of the same wager is a separate row.'
      };
      rows.push({
        schema: RECORD_SCHEMA, recommendation_id: r.recommendation_id, card_id: card.id,
        snapshot_hash: fnv1a(JSON.stringify(snapshot)), built_at: card.built_at,
        sport: r.sport, game_id: r.event_id, matchup: r.matchup, kickoff: r.kickoff,
        market: r.market_key, selection: r.selection, side: r.side || null, handicap: r.line,
        odds_american: r.american_odds, odds_decimal: r.decimal_odds, book: r.sportsbook, price_captured_at: r.price_captured_at, price_age_seconds: r.price_age_seconds, price_freshness: r.price_freshness,
        model_probability: r.model_probability, calibrated_probability: r.calibrated_probability, conservative_probability: r.conservative_probability,
        conservative_method: r.conservative_method, no_vig_market_probability: r.no_vig_market_probability,
        model_edge: r.model_edge, conservative_edge: r.conservative_edge, expected_value: r.expected_value, fair_odds: r.fair_odds,
        reliability_score: r.reliability_score, raw_kelly_fraction: r.raw_kelly_fraction, fractional_kelly_fraction: r.fractional_kelly_fraction,
        recommended_units: r.recommended_units, recommended_dollars: r.recommended_dollars, recommendation_tier: r.recommendation_tier,
        exposure_before_units: r.existing_team_exposure_units, exposure_after_units: r.resulting_team_exposure_units,
        model_version: r.model_version || null, calibration_version: r.calibration_version || null, kernel_version: VERSION,
        status: r.status, kind: kind, pass_reason: snapshot.pass_reason,
        bankroll_amount: card.policy.bankroll_amount, base_unit_amount: card.policy.base_unit_amount,
        sig_key: r.sig_key || null, question: str(extra.question || card.question).slice(0, 500),
        snapshot: snapshot
      });
    });
    /* a forward record precedes the game; said again here so a started game
       can never enter the audit trail as a prediction */
    return rows.filter(function (row) { var k = toMs(row.kickoff), b = toMs(row.built_at); return k == null || b == null || b < k; });
  }

  /* ==================================================================== */
  /* 19. TOOLS                                                            */
  /* ==================================================================== */
  function registerTools() {
    var Rk = R(); if (!Rk || !Rk.TOOLS || !Rk.T) return false;
    var T = Rk.T;
    function tool(name, description, input, run) { Rk.TOOLS[name] = { name: name, llm: true, category: 'calc', description: description, input: input, output: T.any(), run: run }; }
    function C(ctx) { return ctx && ctx.stake_card ? ctx.stake_card : null; }
    tool('get_recommended_units', 'EdgeDesk’s own position size for a selection on this turn’s card: the conservative probability, the expected value at the executable price, the Kelly fractions, every cap applied and the final units and dollars. Never compute a size yourself — read it here. Input: {selection?}.',
      T.obj({ selection: T.opt(T.str({ max: 80 })) }), function (i, ctx) {
        var c = C(ctx); if (!c) return { ok: false, error: 'no staking card on this turn', missing: ['stake_card'] };
        var all = c.recommendations.concat(c.watchlist, c.passes, c.research_only);
        var want = i && i.selection ? normName(i.selection) : null;
        var rows = want ? all.filter(function (r) { var s = normName(r.selection); return s === want || s.indexOf(want) >= 0 || want.indexOf(s) >= 0; }) : c.recommendations;
        return { ok: true, policy: c.policy.basis, bankroll_known: c.policy.bankroll_known, rows: rows, note: c.note };
      });
    tool('get_exposure_ledger', 'The exposure this card would create: units by game, team, sport, day and week, before and after every proposed wager, against the configured caps.',
      T.obj({}), function (i, ctx) { var c = C(ctx); if (!c) return { ok: false, error: 'no staking card on this turn', missing: ['stake_card'] }; return { ok: true, before: c.exposure_before, after: c.exposure_after, caps: c.caps, positions: c.exposure_ledger.positions, portfolio_actions: c.portfolio_actions }; });
    tool('compare_markets_for_game', 'The six markets of one game ranked by conservative expected value after uncertainty and the caps, with the primary, any qualifying secondary, and why each other market lost.',
      T.obj({ game_id: T.opt(T.str({ max: 60 })) }), function (i, ctx) { var c = C(ctx); if (!c) return { ok: false, error: 'no staking card on this turn', missing: ['stake_card'] }; var g = i && i.game_id ? c.games.filter(function (x) { return String(x.game_id) === String(i.game_id); }) : c.games; return { ok: true, games: g }; });
    tool('get_bankroll_policy', 'The reader’s bankroll settings as EdgeDesk read them, every field with its source (stored or default), and what is missing.',
      T.obj({}), function (i, ctx) { var c = C(ctx); if (!c) return { ok: false, error: 'no staking card on this turn', missing: ['stake_card'] }; return { ok: true, policy: c.policy, warnings: c.policy.warnings, dollars_note: c.policy.dollars_note }; });
    return true;
  }
  var TOOL_NAMES = ['get_recommended_units', 'get_exposure_ledger', 'compare_markets_for_game', 'get_bankroll_policy'];

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, CARD_SCHEMA: CARD_SCHEMA, POLICY_SCHEMA: POLICY_SCHEMA, RECORD_SCHEMA: RECORD_SCHEMA, PARLAY_SCHEMA: PARLAY_SCHEMA,
    DEFAULT_POLICY: DEFAULT_POLICY, TIERS: TIERS, STATUSES: STATUSES, GATES: GATES, GATE_BY_CODE: GATE_BY_CODE,
    SIZEABLE_MARKETS: SIZEABLE_MARKETS, CONDITIONAL_MARKETS: CONDITIONAL_MARKETS, RELIABILITY_WEIGHTS: RELIABILITY_WEIGHTS, TOOL_NAMES: TOOL_NAMES,
    settings: settings, quoteCheck: quoteCheck, noVig: noVig, bookDisagreement: bookDisagreement,
    loadStakingValidation: loadStakingValidation, stakingModeFor: stakingModeFor, clearStakingValidation: clearStakingValidation,
    registerValidatedMarket: registerValidatedMarket, validatedExtraMarket: validatedExtraMarket, clearValidatedMarkets: clearValidatedMarkets,
    reliability: reliability, conservativeProbability: conservativeProbability, expectedValue: expectedValue,
    kelly: kelly, roundUnits: roundUnits, tierFor: tierFor, capsFor: capsFor, priceAtLeast: priceAtLeast,
    exposureLedger: exposureLedger, ledgerFor: ledgerFor, addToLedger: addToLedger, correlations: correlations, teamsOf: teamsOf,
    evaluate: evaluate, candidateFromBoard: candidateFromBoard, bestMarket: bestMarket, alternates: alternates,
    buildCard: buildCard, buildParlay: buildParlay, classifyAsk: classifyAsk, wantsStake: wantsStake,
    render: render, recLines: recLines, promptBlock: promptBlock, allowedFrom: allowedFrom, criticExtras: criticExtras,
    records: records, registerTools: registerTools, weekKey: weekKey
  };
});
/*__EDSTAKE_END__*/

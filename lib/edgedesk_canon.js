/* ===========================================================================
   EdgeDesk CANON — one name, one definition, one rule, every surface.

   The research terminal, the app's board and game pages, the Model Lab, the
   exports, the record and the weekly report all read their vocabulary from
   this file. When two pages used to say subtly different things about the
   same game (a rating called "EdgeDesk FBS Rating" beside an "Engine state"
   that is the one actually pricing the game; NEAR PICK'EM on one page and
   RESEARCH on the other; a "verified" gap on one surface that the research
   page could not verify), the fix is made HERE and the pages follow.

   WHAT LIVES HERE
     RATINGS            the two team-strength numbers, named so they cannot be
                        mistaken for each other, and the explanation between
                        them built from the engine's actual structure
     RESEARCH_STATUS    how interesting is this matchup / model disagreement?
     DECISION_STATUS    does the available price justify action? (only the
                        decision engine can produce BET, WAIT or PASS)
     PRICE_STATE        is the price that made the research interesting still
                        there? ("the price is gone")
     MATURITY           what a module has earned: PRODUCTION VALIDATED down to
                        DEPRECATED, one definition each
     VALIDATION BADGES  WALK-FORWARD TRACKED / VALIDATED, CLV PENDING /
                        VALIDATED, with the minimum sample and method for each
     MODULES            every model/module, its maturity and PRICING IMPACT
                        (does it move the line, or only provide context?)
     PRICING INPUTS     what prices a CFB game today, and what does not
     COUNTERS           the canonical counter hierarchy and a definition for
                        every counter: population, threshold, sport, status
     INDEPENDENCE       the sportsbook market never enters the pure fair line
     DISCLAIMER         one canonical statement; pages carry it once

   WHAT THIS FILE NEVER DOES
     - it never computes a projection, a probability or a price;
     - it never promotes a status: a research status is never a decision
       status, and VERIFIED never implies BET (tests pin it);
     - it never invents a value: a missing input stays null and says so.

   Browser: window.EDCanon. Node: require('./edgedesk_canon.js'). ES5, no
   dependencies, the same code in both.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCanon = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var C = { version: 'edgedesk_canon/1' };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function r1(x) { return num(x) == null ? null : Math.round(x * 10) / 10; }
  function r2(x) { return num(x) == null ? null : Math.round(x * 100) / 100; }
  function signed(x, dp) { return num(x) == null ? '—' : (x > 0 ? '+' : (x < 0 ? '−' : '')) + Math.abs(x).toFixed(dp == null ? 1 : dp); }
  function pct(x) { return num(x) == null ? '—' : Math.round(100 * x) + '%'; }
  function freeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { freeze(o[k]); });
    }
    return o;
  }
  C.util = { num: num, r1: r1, r2: r2, signed: signed, pct: pct };

  /* =================================================================
     THE ONE STATEMENT. Pages print it once, near the footer, and carry
     contextual maturity labels everywhere else instead of repeating it.
     ================================================================= */
  C.DISCLAIMER = 'EdgeDesk is a research tool. Its numbers are estimates with measured error, not advice, and nothing on it is a recommendation to bet. 21+. Gamble responsibly — 1-800-GAMBLER.';
  C.DISCLAIMER_SHORT = 'Research, not advice.';

  /* =================================================================
     MODEL INDEPENDENCE — the core differentiator, stated the same way
     on every surface that shows a fair line.
     ================================================================= */
  C.INDEPENDENCE = {
    headline: 'SPORTSBOOK MARKET DOES NOT ENTER THE PURE EDGEDESK FAIR LINE.',
    text: 'The EdgeDesk fair line is built from football information only. The market is read after the projection, and only for:',
    used_for: ['comparison (the model gap)', 'research (which games are worth opening)', 'price evaluation (cover probability at a quoted line)',
      'integrity checks (is a large gap real, or a data problem?)', 'closing-line value (CLV) grading'],
    evidence: '46,920 fuzzed market inputs changed no pure projection (docs/cfb-audit/EXECUTIVE.md); the terminal build refuses to publish if a fair line differs from the champion slate.'
  };

  /* =================================================================
     RATINGS — two numbers, two names, one explanation.

     CURRENT FBS POWER RATING  football/rating/current.json (ETSR). A
       neutral-field research rating: this season's opponent-adjusted
       play-level results, blended with measured carryover, roster/talent and
       verified availability. Its point scale is NOT yet calibrated
       (calibration.measured === false), so it is SHADOW RESEARCH and moves no
       line (football/cfb_p4/engine.js setCanonicalRatings keeps it out).
     PRODUCTION PRICING STATE  the V1 engine's team-strength state that the
       fair spread is priced from: a trained seed table (through 2025),
       decayed by the learned carry-over (0.75) at the season break and
       updated game by game from capped margins, blended with a
       this-season-only track on a learned prior-weight curve
       (EDCfbP4Params.blend.prior_weight_by_week).
     ================================================================= */
  C.RATINGS = {
    CURRENT_FBS_POWER_RATING: {
      key: 'CURRENT_FBS_POWER_RATING', label: 'CURRENT FBS POWER RATING', short: 'Current rating',
      model: 'ETSR — EdgeDesk Team Strength Rating', artifact: 'football/rating/current.json',
      measures: 'Current team-strength research view: this season’s opponent-adjusted play-level results, blended with measured carryover, roster/talent and verified availability, in points against an average FBS team on a neutral field.',
      prices_games: false, maturity: 'SHADOW',
      why_not_priced: 'Its point scale is not yet calibrated (calibration.measured is false), so it is loaded as SHADOW research and moves no line.'
    },
    PRODUCTION_PRICING_STATE: {
      key: 'PRODUCTION_PRICING_STATE', label: 'PRODUCTION PRICING STATE', short: 'Pricing state',
      model: 'V1 engine team-strength state (edgedesk_cfb_p4)', artifact: 'football/cfb_p4/engine.js strength state, replayed from football/cfb_p4/params.js',
      measures: 'The latent trained state currently feeding the pricing engine: a long-run state trained through 2025, carried into this season, updated game by game, and blended with a this-season-only track on a learned curve.',
      prices_games: true, maturity: 'PRODUCTION',
      why_priced: 'It is the Layer-1 team-strength mean of the governance champion (edgedesk_cfb_p4_v1.0.0), walk-forward tested on 2022–2025.'
    }
  };
  /* the learned curve, as shipped (EDCfbP4Params.blend.prior_weight_by_week),
     so the explanation can name the weight even where params are not loaded */
  C.PRIOR_WEIGHT_FALLBACK = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 0.8, 5: 0.8, 6: 0.6 };
  C.priorWeightAt = function (gp, curve) {
    var c = curve || C.PRIOR_WEIGHT_FALLBACK, g = num(gp) == null ? 0 : Math.max(0, Math.min(15, Math.round(gp)));
    if (num(c[g]) != null) return c[g];
    if (num(c[String(g)]) != null) return c[String(g)];
    return num(c[6]) != null ? c[6] : (num(c['6']) != null ? c['6'] : null);
  };
  /* the divergence bands. TEAM: set from the current 138-team distribution
     by the validation build (p50 / p90 of |divergence|), these are only the
     defaults. GAME: fitted on the 2015–2021 development fold of the walk-
     forward replay (football/cfb_validation/divergence_backtest.json). */
  C.DIVERGENCE = {
    team: { elevated: 4, large: 8, basis: 'default bands; the validation build replaces them with the current distribution’s p50 / p90' },
    game: { moderate: 2.82, large: 7.22, basis: '|current-rating gap − pricing-state gap| p50 / p90 on the 2015–2021 development fold of the walk-forward replay' }
  };
  function band(abs, cut, keys) {
    if (num(abs) == null) return null;
    return abs >= cut[keys[1]] ? 'LARGE' : (abs >= cut[keys[0]] ? (keys[0] === 'elevated' ? 'ELEVATED' : 'MODERATE') : 'NORMAL');
  }
  C.teamDivergenceBand = function (abs, cut) { return band(abs, cut || C.DIVERGENCE.team, ['elevated', 'large']); };
  C.gameDivergenceBand = function (abs, cut) { return band(abs, cut || C.DIVERGENCE.game, ['moderate', 'large']); };

  /* ONE TEAM: the two numbers, the difference and WHY, from the model's
     actual structure. Nothing here is a guess: every reason is a component
     one of the two numbers actually carries.
       x.current  { rating, components:{results:{rating,weight,games}, carryover:{applied},
                    roster:{points,available}, availability:{contribution|points}}, confidence }
       x.state    { value, carried, this_season, prior_weight, games_played }
       x.centers  { current, state }  FBS means of each scale (optional)
       x.cut      team bands (optional) */
  C.ratingPair = function (x) {
    x = x || {};
    var cur = x.current || {}, st = x.state || {}, ctr = x.centers || {};
    var cv = num(cur.rating), sv = num(st.value);
    var out = { team: x.team || null, current: cv, state: sv, difference: null, center_offset: null, divergence: null,
      band: null, expected: null, why: [], current_label: C.RATINGS.CURRENT_FBS_POWER_RATING.label,
      state_label: C.RATINGS.PRODUCTION_PRICING_STATE.label, prices: 'PRODUCTION PRICING STATE',
      shadow: 'CURRENT FBS POWER RATING is shadow research: it moves no line.' };
    if (cv == null || sv == null) {
      out.why.push(cv == null ? 'No current FBS power rating is on file for this team.' : 'This team has no production pricing state yet (no trained seed and no absorbed game), so its games are refused a graded projection rather than priced from a default.');
      return freeze(out);
    }
    out.difference = r2(sv - cv);
    var off = (num(ctr.state) != null && num(ctr.current) != null) ? ctr.state - ctr.current : null;
    out.center_offset = r2(off);
    out.divergence = r2(off == null ? cv - sv : (cv - num(ctr.current)) - (sv - num(ctr.state)));
    out.band = C.teamDivergenceBand(Math.abs(out.divergence), x.cut);
    var w = num(st.prior_weight), ca = num(st.carried), ts = num(st.this_season), gp = num(st.games_played);
    /* 1 — the pricing state's own blend */
    if (w != null && ca != null && ts != null) {
      out.why.push('The pricing state is ' + Math.round(100 * w) + '% the long-run trained state (' + signed(ca) + ') and '
        + Math.round(100 * (1 - w)) + '% this season’s own track (' + signed(ts) + ')'
        + (gp != null ? ': the learned prior-weight curve keeps ' + Math.round(100 * w) + '% on the long-run state at ' + gp + ' game' + (gp === 1 ? '' : 's') + ' played (it falls to 60% from 6 games).' : '.'));
    }
    /* 2 — the current rating's own blend */
    var comp = cur.components || {}, res = comp.results || {}, carry = comp.carryover || {}, ros = comp.roster || {}, av = comp.availability || {};
    if (num(res.rating) != null && num(res.weight) != null)
      out.why.push('The current rating weights this season’s opponent-adjusted play-level results at ' + Math.round(100 * res.weight) + '% (' + signed(res.rating) + ' from '
        + (num(res.games) != null ? res.games + ' game' + (res.games === 1 ? '' : 's') : 'this season') + ')'
        + (num(carry.applied) != null ? ', with ' + signed(carry.applied) + ' of measured carryover from last season.' : '.'));
    if (ros.available && num(ros.points) != null && Math.abs(ros.points) >= 1)
      out.why.push('The current rating includes a roster/talent term of ' + signed(ros.points) + ' pts. Roster talent enters no production price (it widens uncertainty only).');
    var avc = num(av.contribution) != null ? av.contribution : num(av.points);
    if (avc != null && Math.abs(avc) >= 0.25)
      out.why.push('The current rating includes ' + signed(avc) + ' pts of verified availability. Production pricing strips it and prices a reported quarterback absence in the game’s injury term instead.');
    if (off != null && Math.abs(off) >= 0.5)
      out.why.push(signed(off) + ' pts of the raw difference is the two scales’ different FBS average, not a football difference; the team-specific divergence is ' + signed(out.divergence) + '.');
    if (gp != null && gp < 3)
      out.why.push('Only ' + gp + ' game' + (gp === 1 ? '' : 's') + ' absorbed this season: both numbers still lean mostly on prior-season information.');
    out.expected = out.band === 'LARGE' ? false : true;
    out.expected_text = out.band === 'LARGE'
      ? 'UNUSUAL — among the largest divergences on the FBS board. Diagnostic only: large game-level divergence has historically come with larger model error, so it widens caution, never the line.'
      : (out.band === 'ELEVATED' ? 'EXPECTED, but larger than typical: the two numbers are built differently (see why).'
        : 'EXPECTED — inside the normal range for two differently built ratings.');
    return freeze(out);
  };

  /* ONE GAME: the difference of the two ratings' team gaps, the quantity the
     divergence backtest measures. Neutral-field gaps: home minus away. */
  C.gameDivergence = function (x) {
    x = x || {};
    var ch = num(x.current_home), ca = num(x.current_away), sh = num(x.state_home), sa = num(x.state_away);
    if (ch == null || ca == null || sh == null || sa == null) return freeze({ available: false, reason: 'both ratings are needed for both teams' });
    var d = (ch - ca) - (sh - sa), b = C.gameDivergenceBand(Math.abs(d), x.cut);
    return freeze({ available: true, current_gap: r2(ch - ca), state_gap: r2(sh - sa), divergence: r2(d), abs: r2(Math.abs(d)), band: b,
      flag: b === 'LARGE',
      text: b === 'LARGE' ? 'Large rating-state divergence (' + Math.abs(d).toFixed(1) + ' pts): the current rating and the pricing state disagree about this matchup. Historically these games carried larger model error — a research and uncertainty flag, not a price adjustment.'
        : (b === 'MODERATE' ? 'Moderate rating-state divergence (' + Math.abs(d).toFixed(1) + ' pts).' : 'The current rating and the pricing state agree about this matchup (within ' + Math.abs(d).toFixed(1) + ' pts).') });
  };

  /* =================================================================
     RESEARCH STATUS — "how interesting is this matchup / disagreement?"
     One word per game, the same on every page. The first rule that holds
     wins (C.researchStatus). Never a bet.
     ================================================================= */
  C.RESEARCH_STATUS = {
    VERIFIED_MAJOR: { key: 'VERIFIED_MAJOR', label: 'VERIFIED MAJOR DISAGREEMENT', short: 'VERIFIED MAJOR', tone: 'verified', rank: 9,
      means: '7+ point model–market disagreement that passed every check of the integrity gate. Still not a bet.' },
    INVESTIGATE: { key: 'INVESTIGATE', label: 'INVESTIGATE', short: 'INVESTIGATE', tone: 'investigate', rank: 8,
      means: 'Large (7+ point) disagreement that has not cleared the integrity gate. At that size missing information is more often the cause than an edge.' },
    MARKET_FAULT: { key: 'MARKET_FAULT', label: 'MARKET FAULT', short: 'MARKET FAULT', tone: 'investigate', rank: 7,
      means: 'A 7+ point disagreement the market cannot verify: too few fresh books, a stale capture, or books that disagree with each other. Counted under INVESTIGATE.' },
    WORTH_RESEARCHING: { key: 'WORTH_RESEARCHING', label: 'WORTH RESEARCHING', short: 'RESEARCH', tone: 'research', rank: 6,
      means: '2–7 point model–market disagreement at a fresh market, with usable football confidence and reliability. Worth opening — not a bet.' },
    NEAR_PICKEM: { key: 'NEAR_PICKEM', label: 'NEAR PICK’EM', short: 'NEAR PK', tone: 'aligned', rank: 4,
      means: 'EdgeDesk’s raw margin is under 1 point and the market is within 2 points of it: no real separation between the teams, no disagreement to research.' },
    MARKET_ALIGNED: { key: 'MARKET_ALIGNED', label: 'MARKET ALIGNED', short: 'ALIGNED', tone: 'aligned', rank: 3,
      means: 'EdgeDesk and the market are within 2 points: not enough disagreement to research the price.' },
    LIMITED_DATA: { key: 'LIMITED_DATA', label: 'LIMITED DATA', short: 'LIMITED', tone: 'quiet', rank: 2,
      means: 'EdgeDesk has a number but cannot trust it enough to research the gap: no valid projection, football confidence under 35, or reliability under 60.' },
    NO_MARKET: { key: 'NO_MARKET', label: 'NO MARKET', short: 'NO MARKET', tone: 'quiet', rank: 1,
      means: 'No usable current quote: none captured, or only one older than 180 minutes. Nothing to compare with.' },
    DATA_FAULT: { key: 'DATA_FAULT', label: 'DATA FAULT', short: 'DATA FAULT', tone: 'fault', rank: 0,
      means: 'An integrity check found a data problem (a mis-joined line, an inverted spread, an unverified gap past the 21-point guard). EdgeDesk’s number is unsafe until it is explained.' }
  };
  C.RESEARCH_KEYS = ['VERIFIED_MAJOR', 'INVESTIGATE', 'MARKET_FAULT', 'WORTH_RESEARCHING', 'NEAR_PICKEM', 'MARKET_ALIGNED', 'LIMITED_DATA', 'NO_MARKET', 'DATA_FAULT'];
  C.THRESHOLDS = { research_gap: 2, major_gap: 7, guard_gap: 21, near_pickem: 1, min_confidence: 35, min_reliability: 60, stale_minutes: 180 };

  /* the rule, over a normalised game:
       x.projected (bool) · x.fault (string|null) · x.market ('FRESH'|'STALE'|'NONE')
       x.gap (abs pts|null) · x.verification ('VERIFIED'|'MARKET_FAULT'|'DATA_FAULT'|other)
       x.confidence · x.reliability · x.fair_margin (raw home margin) */
  C.researchStatus = function (x) {
    x = x || {};
    var T = C.THRESHOLDS, gap = num(x.gap), conf = num(x.confidence), rel = num(x.reliability), fm = num(x.fair_margin);
    function out(k, why, rule) { var s = C.RESEARCH_STATUS[k]; return { key: k, label: s.label, short: s.short, tone: s.tone, rank: s.rank, means: s.means, reason: why, rule: rule }; }
    if (x.fault) return out('DATA_FAULT', String(x.fault), 'fault');
    if (!x.projected) return out('LIMITED_DATA', x.unprojected_reason || 'EdgeDesk has no valid projection for this game.', 'not_projected');
    if (x.verification === 'DATA_FAULT') return out('DATA_FAULT', 'The integrity gate found a data problem.', 'gate_data_fault');
    if (gap != null && gap > T.guard_gap && x.verification !== 'VERIFIED') return out('DATA_FAULT', 'A ' + gap.toFixed(1) + '-point gap past the ' + T.guard_gap + '-point guard bound, unverified.', 'guard');
    if (x.market === 'NONE' || x.market == null) return out('NO_MARKET', 'No current spread quote is on file.', 'no_market');
    if (x.market === 'STALE') return out('NO_MARKET', 'The only quote on file is older than ' + T.stale_minutes + ' minutes: not a price.', 'stale_market');
    if (gap != null && gap >= T.major_gap) {
      if (x.verification === 'VERIFIED') return out('VERIFIED_MAJOR', 'A ' + gap.toFixed(1) + '-point gap that passed every integrity check.', 'verified');
      if (x.verification === 'MARKET_FAULT') return out('MARKET_FAULT', 'A ' + gap.toFixed(1) + '-point gap the market cannot verify' + (x.verification_reason ? ': ' + x.verification_reason : '') + '.', 'market_fault');
      return out('INVESTIGATE', 'A ' + gap.toFixed(1) + '-point gap that has not passed the integrity gate' + (x.verification_reason ? ': ' + x.verification_reason : '') + '.', 'unverified');
    }
    if (conf == null || conf < T.min_confidence) return out('LIMITED_DATA', 'Football confidence ' + (conf == null ? 'unmeasured' : Math.round(conf)) + ' is under the ' + T.min_confidence + ' floor.', 'confidence');
    if (rel != null && rel < T.min_reliability) return out('LIMITED_DATA', 'Reliability ' + Math.round(rel) + ' is under ' + T.min_reliability + ': a gap on unreliable inputs is more suspicious, not less.', 'reliability');
    if (gap != null && gap >= T.research_gap) return out('WORTH_RESEARCHING', 'A ' + gap.toFixed(1) + '-point disagreement at a fresh market with usable confidence and reliability.', 'research_gap');
    if (fm != null && Math.abs(fm) < T.near_pickem) return out('NEAR_PICKEM', 'EdgeDesk’s raw margin is ' + Math.abs(fm).toFixed(2) + ' pts and the market is within ' + T.research_gap + ' pts.', 'near_pickem');
    return out('MARKET_ALIGNED', 'EdgeDesk and the market are ' + (gap == null ? '—' : gap.toFixed(1)) + ' pts apart, inside the ' + T.research_gap + '-point research threshold.', 'aligned');
  };

  /* the older label vocabularies, mapped once (docs/cfb-validation/TERMINOLOGY.md) */
  C.LEGACY = {
    /* lib/cfb_research_view.js researchLabel keys (+ rule where it decides) */
    VERIFIED_MAJOR_DISAGREEMENT: 'VERIFIED_MAJOR', INVESTIGATE: 'INVESTIGATE', MARKET_FAULT: 'MARKET_FAULT', DATA_FAULT: 'DATA_FAULT',
    WORTH_RESEARCHING: 'WORTH_RESEARCHING', NEAR_PICKEM: 'NEAR_PICKEM', MARKET_ALIGNED: 'MARKET_ALIGNED',
    LOW_RELIABILITY: 'LIMITED_DATA', LIMITED_DATA: 'LIMITED_DATA', NO_MARKET: 'NO_MARKET',
    /* the app board's operational labels */
    'STALE QUOTE': 'NO_MARKET', 'NO MARKET': 'NO_MARKET', 'THIN DATA': 'LIMITED_DATA', 'AWAITING DATA': 'LIMITED_DATA',
    'DATA FAULT': 'DATA_FAULT', 'RESEARCH LEAN': 'WORTH_RESEARCHING', 'MARKET ALIGNED': 'MARKET_ALIGNED'
  };
  C.fromResearchView = function (lab) {
    if (!lab || !lab.key) return null;
    if (lab.key === 'LIMITED_DATA' && (lab.rule === 'no_market' || lab.rule === 'stale_market')) return 'NO_MARKET';
    return C.LEGACY[lab.key] || null;
  };

  /* the research status of a finished research-terminal object
     (lib/cfb_terminal.js T.build) — the same rule, fed the object's own fields */
  C.researchStatusOfTerminal = function (o) {
    if (!o) return null;
    var A = o.edgedesk || {}, B = o.market || {}, D = o.disagreement || {}, S = o.status || {}, DQ = o.data_quality || {};
    var fault = null;
    if (S.key === 'DATA_FAULT') fault = S.reason || 'data fault';
    return C.researchStatus({
      projected: !!A.available, fault: fault,
      unprojected_reason: A.reason,
      market: !B.available ? 'NONE' : (B.stale ? 'STALE' : 'FRESH'),
      gap: D.available ? D.points : null,
      verification: D.verification,
      verification_reason: D.integrity && D.integrity.failed && D.integrity.failed[0] ? D.integrity.failed[0] : null,
      confidence: A.available && A.football_confidence ? A.football_confidence.score : null,
      reliability: DQ.reliability, fair_margin: A.available ? A.home_margin : null
    });
  };

  /* =================================================================
     DECISION STATUS — "does the available price justify action?"
     Only the decision engine (football/cfb_decision/decision.js, fail
     closed) produces BET, WAIT or PASS. Where it has not evaluated a game
     the status is NO DECISION, never a guessed PASS. VERIFIED never
     implies BET.
     ================================================================= */
  C.DECISION_STATUS = {
    BET: { key: 'BET', label: 'BET', tone: 'bet', means: 'The decision engine certified a wager at a named price: every validated threshold cleared and betting is enabled by policy.' },
    WAIT: { key: 'WAIT', label: 'WAIT', tone: 'wait', means: 'The decision engine’s validated timing rule says a named price or piece of information should come first. Shown only when that rule is enabled by policy.' },
    PASS: { key: 'PASS', label: 'PASS', tone: 'pass', means: 'The decision engine evaluated this price and it does not justify action. The blocker is always printed.' },
    NO_DECISION: { key: 'NO_DECISION', label: 'NO DECISION', tone: 'quiet', means: 'The decision engine did not evaluate this game (no usable price, a data fault, or no projection). Nothing is implied.' }
  };
  C.DECISION_KEYS = ['BET', 'WAIT', 'PASS', 'NO_DECISION'];
  /* d = the engine's verdict {status, reason_codes, reasons}; policy =
     {bet_enabled, wait_enabled}; evaluated = did the engine see a price? */
  C.decisionStatus = function (d, policy, evaluated) {
    policy = policy || {};
    var s = d && d.status ? String(d.status).toUpperCase() : null;
    function out(k, why) { var x = C.DECISION_STATUS[k]; return { key: k, label: x.label, tone: x.tone, means: x.means, reason: why, engine_status: s }; }
    if (!evaluated || !s) return out('NO_DECISION', (d && d.reasons && d.reasons[0]) || 'The decision engine did not evaluate a price for this game.');
    if (s === 'BET') {
      if (policy.bet_enabled !== true) return out('PASS', 'Betting is disabled by the frozen decision policy; a BET cannot be shown.');
      return out('BET', (d.reasons && d.reasons[0]) || 'Certified by the decision engine.');
    }
    if (s === 'WAIT') {
      if (policy.wait_enabled !== true) return out('PASS', 'The policy’s WAIT rule is disabled (no validated timing evidence), so waiting is not a decision EdgeDesk can make.');
      return out('WAIT', (d.reasons && d.reasons[0]) || 'Validated timing rule.');
    }
    return out('PASS', (d.reasons && d.reasons[0]) ? 'Decision engine: ' + d.reasons[0] : 'The decision engine does not certify this price.');
  };

  /* WHY THIS IS NOT A BET — the blocker, stated with the numbers. */
  C.whyNotBet = function (x) {
    x = x || {};
    var rows = [], cov = num(x.cover), be = num(x.break_even), err = num(x.expected_error);
    if (x.bet_enabled === false) rows.push({ code: 'BETTING_DISABLED', text: 'Betting is disabled by the frozen decision policy until the decision engine passes its promotion gate.' });
    if (cov != null && be != null) {
      var m = cov - be;
      rows.push({ code: m > 0 ? 'THIN_MARGIN' : 'BELOW_BREAK_EVEN',
        text: 'EdgeDesk cover probability ' + (100 * cov).toFixed(1) + '% vs break-even ' + (100 * be).toFixed(1) + '%'
          + (m > 0 ? ': a margin of ' + (100 * m).toFixed(1) + ' pp, small against EdgeDesk’s typical miss of ' + (err != null ? err.toFixed(1) + ' pts' : 'about 12–13 pts') + '. Cover probabilities have not been shown to carry skill (docs/cfb-audit/EXECUTIVE.md §6).'
            : ': the price does not clear break-even.') });
    }
    if (x.research_status === 'INVESTIGATE' || x.research_status === 'MARKET_FAULT') rows.push({ code: 'UNVERIFIED', text: 'The large gap is not verified: missing information is the likelier cause.' });
    if (x.price_state === 'PRICED_IN' || x.price_state === 'GONE') rows.push({ code: 'PRICE_GONE', text: 'The price that made this interesting is gone: the market has moved to EdgeDesk’s number.' });
    (x.extra || []).forEach(function (t) { rows.push(t); });
    return rows;
  };

  /* =================================================================
     PRICE STATE — "the price is gone". The football opinion can stand
     while the price that made it interesting disappears. Read from the
     edge-decay series (lib/cfb_terminal.js T.edgeDecay): the initial gap
     when both numbers were first on file vs the gap now, same side.
     ================================================================= */
  C.PRICE_STATE = {
    AVAILABLE: { key: 'AVAILABLE', label: 'PRICE STILL AVAILABLE', tone: 'research', means: 'Most of the initial disagreement is still available at the current market.' },
    PARTIAL: { key: 'PARTIAL', label: 'PART OF THE EDGE PRICED IN', tone: 'wait', means: 'The market has moved part of the way to EdgeDesk’s number since the disagreement first appeared.' },
    PRICED_IN: { key: 'PRICED_IN', label: 'EDGE MOSTLY PRICED IN', tone: 'quiet', means: 'The market has moved most of the way to EdgeDesk’s number. The football opinion may stand; the price that made it interesting is mostly gone.' },
    GONE: { key: 'GONE', label: 'PRICE NO LONGER ATTRACTIVE', tone: 'quiet', means: 'The market has reached or passed EdgeDesk’s number: the disagreement is gone or reversed.' },
    NO_INITIAL: { key: 'NO_INITIAL', label: 'NO INITIAL EDGE', tone: 'quiet', means: 'There was no research-sized disagreement when both numbers were first on file.' },
    UNKNOWN: { key: 'UNKNOWN', label: 'PRICE HISTORY UNKNOWN', tone: 'quiet', means: 'Only one moment with both EdgeDesk and the market on file.' }
  };
  C.priceState = function (decay) {
    var v = decay && decay.available ? decay.verdict : null, k;
    if (!v) k = 'UNKNOWN';
    else if (v === 'NO_INITIAL_EDGE') k = 'NO_INITIAL';
    else if (v === 'REVERSED') k = 'GONE';
    else if (v === 'MOST_GONE') k = 'PRICED_IN';
    else if (v === 'PARTIAL') k = 'PARTIAL';
    else k = 'AVAILABLE';
    var s = C.PRICE_STATE[k];
    return { key: k, label: s.label, tone: s.tone, means: s.means,
      initial: decay && decay.initial ? decay.initial.points : null, current: decay && decay.current ? decay.current.points : null,
      text: decay && decay.text ? decay.text : s.means };
  };

  /* =================================================================
     FAVORITE FLIP — EdgeDesk and the market disagree on who is favoured,
     not just by how much. Both sides must be at least half a point.
     ================================================================= */
  C.favoriteFlip = function (fairMargin, marketMargin) {
    var f = num(fairMargin), m = num(marketMargin);
    if (f == null || m == null) return false;
    return (f > 0) !== (m > 0) && Math.abs(f) >= 0.5 && Math.abs(m) >= 0.5;
  };
  C.FAVORITE_FLIP = { label: 'FAVORITE FLIP', means: 'EdgeDesk and the market favour different teams. Qualitatively more extreme than a disagreement on margin alone; the integrity gate applies its 10-point rules to a flip.' };

  /* =================================================================
     MATURITY — what a module has earned. One definition each.
     ================================================================= */
  C.MATURITY = {
    PRODUCTION_VALIDATED: { key: 'PRODUCTION_VALIDATED', label: 'PRODUCTION VALIDATED', rank: 6,
      means: 'In production and prospectively validated: its walk-forward badge and, where it makes price claims, its CLV badge are earned under the rules below.' },
    PRODUCTION: { key: 'PRODUCTION', label: 'PRODUCTION', rank: 5,
      means: 'The governed champion or a production component: it produces the published number, is walk-forward tested on history, and is tracked prospectively — but has not yet earned PRODUCTION VALIDATED on live, frozen predictions.' },
    SHADOW: { key: 'SHADOW', label: 'SHADOW', rank: 4,
      means: 'Runs beside production on the same games and is graded the same way, but its output moves no published number.' },
    EXPERIMENTAL: { key: 'EXPERIMENTAL', label: 'EXPERIMENTAL', rank: 3,
      means: 'Tracked prospectively. The current version has not yet accumulated enough closing-line evidence for validated betting claims.' },
    RESEARCH_ONLY: { key: 'RESEARCH_ONLY', label: 'RESEARCH ONLY', rank: 2,
      means: 'Shown and explained as context. It has not passed walk-forward validation, so it moves no line and makes no probability claim.' },
    UNVALIDATED: { key: 'UNVALIDATED', label: 'UNVALIDATED', rank: 1,
      means: 'Computed and displayed, but its own validation failed or has not run: read it as a description, not as evidence.' },
    DEPRECATED: { key: 'DEPRECATED', label: 'DEPRECATED', rank: 0,
      means: 'Retired. Kept for the record; no longer computed for new games.' }
  };
  C.MATURITY_KEYS = ['PRODUCTION_VALIDATED', 'PRODUCTION', 'SHADOW', 'EXPERIMENTAL', 'RESEARCH_ONLY', 'UNVALIDATED', 'DEPRECATED'];

  /* =================================================================
     VALIDATION BADGES — earned under stated rules, never from merely
     having results. The thresholds are the governance bars already on
     record (docs/cfb-audit/EXECUTIVE.md §9): promotion needs about one
     season of settled prospective games with the MAE difference's 95% CI
     below zero and calibration and coverage in band; any betting claim
     needs 200+ settled, priced, multi-book decisions with CLV above zero.
     ================================================================= */
  C.BADGE_RULES = {
    WALK_FORWARD_TRACKED: { label: 'WALK-FORWARD TRACKED',
      rule: 'Predictions of this exact version are frozen write-once before kickoff in the Model Lab ledger (origin LIVE) and graded after the game. No minimum: it is a statement about method, not performance.' },
    WALK_FORWARD_VALIDATED: { label: 'WALK-FORWARD VALIDATED', min_n: 700,
      rule: 'At least 700 settled prospective (LIVE, frozen pre-kickoff) games of this exact version; an MAE difference whose 95% bootstrap CI lies entirely below zero — against the model it replaces for a challenger, or against its own pre-registered holdout reference + 0.25 pts for the incumbent (the backtest holds prospectively); win-probability calibration error (ECE) at most 0.03; 80% interval coverage between 75% and 85%.' },
    CLV_PENDING: { label: 'CLV PENDING',
      rule: 'Closing-line value is being recorded, but fewer than 200 settled, priced, multi-book decisions exist, or the 95% CI of mean CLV includes zero.' },
    CLV_VALIDATED: { label: 'CLV VALIDATED', min_n: 200,
      rule: 'At least 200 settled decisions priced at a real quote with 2+ books at the close; mean CLV above zero with the 95% bootstrap CI lower bound above zero.' }
  };
  /* ev = { tracked_live_n, settled_live_n, mae_diff_ci:[lo,hi], ece, cov80,
            clv_n, clv_ci:[lo,hi], makes_price_claims } */
  C.validationBadges = function (ev) {
    ev = ev || {};
    var out = [], R = C.BADGE_RULES;
    var tracked = num(ev.tracked_live_n) != null && ev.tracked_live_n > 0;
    if (tracked) out.push({ key: 'WALK_FORWARD_TRACKED', label: R.WALK_FORWARD_TRACKED.label, earned: true, detail: ev.tracked_live_n + ' frozen live prediction' + (ev.tracked_live_n === 1 ? '' : 's') + ' on file' });
    var n = num(ev.settled_live_n) || 0, ci = ev.mae_diff_ci, ece = num(ev.ece), cov = num(ev.cov80);
    var wfv = n >= R.WALK_FORWARD_VALIDATED.min_n && ci && num(ci[1]) != null && ci[1] < 0 && ece != null && ece <= 0.03 && cov != null && cov >= 0.75 && cov <= 0.85;
    out.push({ key: 'WALK_FORWARD_VALIDATED', label: R.WALK_FORWARD_VALIDATED.label, earned: !!wfv,
      progress: n + ' / ' + R.WALK_FORWARD_VALIDATED.min_n + ' settled live games',
      detail: wfv ? 'earned' : (n < R.WALK_FORWARD_VALIDATED.min_n ? 'not earned: ' + n + ' of ' + R.WALK_FORWARD_VALIDATED.min_n + ' settled live games' : 'not earned: the sample is there, the evidence is not (MAE CI, calibration or coverage outside the rule)') });
    if (ev.makes_price_claims) {
      var cn = num(ev.clv_n) || 0, cci = ev.clv_ci;
      var clvOk = cn >= R.CLV_VALIDATED.min_n && cci && num(cci[0]) != null && cci[0] > 0;
      out.push(clvOk ? { key: 'CLV_VALIDATED', label: R.CLV_VALIDATED.label, earned: true, detail: cn + ' settled priced decisions, CLV CI above zero' }
        : { key: 'CLV_PENDING', label: R.CLV_PENDING.label, earned: false, progress: cn + ' / ' + R.CLV_VALIDATED.min_n + ' settled priced multi-book decisions', detail: 'CLV not validated' });
    }
    return out;
  };

  /* =================================================================
     THE MODULE REGISTRY — every model and research module, its maturity
     and whether it MOVES THE LINE. Static facts; the validation build
     (football/cfb_validation/build.js) fills the live counts and badges
     and publishes football/cfb_validation/maturity.json.
     ================================================================= */
  C.MODULES = [
    { id: 'cfb_v1', name: 'CFB production pricing model (V1)', sport: 'CFB', version: 'edgedesk_cfb_p4_v1.0.0', maturity: 'PRODUCTION', pricing_impact: true,
      training_cutoff: 'trained through the 2025 season; walk-forward held out 2022–2025', role: 'governance champion',
      reason: 'The governance champion: every published CFB fair spread comes from it. Walk-forward tested on history (MAE 12.77 vs close 12.02, 2022–2025); not yet prospectively validated.' },
    { id: 'cfb_v2', name: 'CFB V2.1 challenger', sport: 'CFB', version: 'edgedesk_cfb_v2.1.0', maturity: 'SHADOW', pricing_impact: false,
      training_cutoff: 'weekly Tuesday freeze; 2024–2025 used in development', role: 'challenger',
      reason: 'Graded beside V1 on every game; promotion needs about one season of prospective evidence (docs/cfb-audit/EXECUTIVE.md §9).' },
    { id: 'etsr', name: 'Current FBS Power Rating (ETSR)', sport: 'CFB', version: 'edgedesk_national_rankings_v1', maturity: 'SHADOW', pricing_impact: false,
      training_cutoff: 'rebuilt weekly', role: 'research rating',
      reason: 'Point-scale calibration not yet measured (calibration.measured is false), so it stays out of pricing.' },
    { id: 'player_quality', name: 'Player quality', sport: 'CFB', version: 'football/players/current.json', maturity: 'RESEARCH_ONLY', pricing_impact: false,
      training_cutoff: 'rebuilt weekly', role: 'research module',
      reason: 'Walk-forward validation not yet passed.' },
    { id: 'personnel', name: 'Personnel availability impact (non-QB)', sport: 'CFB', version: 'football/personnel', maturity: 'RESEARCH_ONLY', pricing_impact: false,
      training_cutoff: '—', role: 'research module', reason: 'Measurement only: the coefficient is not trained, so the projection effect is 0.0 points.' },
    { id: 'qb_absence', name: 'Quarterback absence term', sport: 'CFB', version: 'edgedesk_cfb_p4_v1.0.0', maturity: 'PRODUCTION', pricing_impact: true,
      training_cutoff: '2,846 games through 2025', role: 'V1 component',
      reason: 'Prices 3.90 pts only when a primary quarterback absence is reported; QB quality (EPA) itself is not priced for college.' },
    { id: 'v1_matchup', name: 'V1 stylistic matchup term', sport: 'CFB', version: 'edgedesk_cfb_p4_v1.0.0', maturity: 'PRODUCTION', pricing_impact: true,
      training_cutoff: 'through 2025', role: 'V1 component', reason: 'Part of the champion’s fair spread (median 1.1 pts, p99 4.6).' },
    { id: 'matchup_intel', name: 'Matchup intelligence cards', sport: 'CFB', version: 'football/cfb_matchup', maturity: 'RESEARCH_ONLY', pricing_impact: false,
      training_cutoff: '—', role: 'research module', reason: 'Unit-versus-unit context; the matchup shadow is not promoted.' },
    { id: 'integrity_gate', name: 'Major-disagreement integrity gate', sport: 'CFB', version: 'lib/cfb_disagreement.js', maturity: 'PRODUCTION', pricing_impact: false,
      training_cutoff: 'parameters fitted on 2015–2021', role: 'research label',
      reason: 'Decides VERIFIED MAJOR vs INVESTIGATE; labels research, never prices.' },
    { id: 'margin_calibrator', name: 'Football-only margin calibrator', sport: 'CFB', version: 'cfb_margin_cal_v1', maturity: 'SHADOW', pricing_impact: false,
      training_cutoff: '2015–2025 walk-forward', role: 'shadow', reason: 'Walk-forward gain −0.041 MAE, under the 0.05 promotion bar.' },
    { id: 'decision_engine', name: 'Decision engine (BET / PASS)', sport: 'CFB', version: 'cfb_decision_policy_v1', maturity: 'SHADOW', pricing_impact: false,
      training_cutoff: 'frozen policy', role: 'decision', reason: 'Betting disabled by policy: calibrated EV is below zero at every price.' },
    { id: 'market_timing', name: 'Market timing (bet now vs wait)', sport: 'CFB', version: 'cfb_decision_policy_v1.wait', maturity: 'UNVALIDATED', pricing_impact: false,
      training_cutoff: '—', role: 'decision', reason: 'The policy’s WAIT rule is disabled: no validated evidence that waiting pays.' },
    { id: 'clv_prediction', name: 'CLV / market-intelligence challenger', sport: 'CFB', version: 'football/cfb_market', maturity: 'SHADOW', pricing_impact: false,
      training_cutoff: '—', role: 'research', reason: 'Market-informed; kept apart from the pure line by design and never priced.' },
    { id: 'reliability', name: 'Reliability score', sport: 'CFB', version: 'lib/cfb_reliability.js', maturity: 'UNVALIDATED', pricing_impact: false,
      training_cutoff: '—', role: 'gate', reason: 'Describes input completeness; its correlation with error is about zero, so it gates display only.' },
    { id: 'nfl_model', name: 'NFL spread model', sport: 'NFL', version: 'football/engine.js', maturity: 'EXPERIMENTAL', pricing_impact: true,
      training_cutoff: 'see docs/model-card-football.md', role: 'NFL fair line',
      reason: 'Prices the NFL fair line. Tier LEAN: break-even history at 1.5+ pts of disagreement, not a profit (football/validation/pricing_nfl.json).' },
    { id: 'ufc_research', name: 'UFC research layer', sport: 'UFC', version: 'ufc-research-1.0', maturity: 'RESEARCH_ONLY', pricing_impact: false,
      training_cutoff: '—', role: 'research', reason: 'No EdgeDesk UFC model exists: the one probability shown is the market’s, de-vigged and labelled as such.' }
  ];
  C.module = function (id) { for (var i = 0; i < C.MODULES.length; i++) if (C.MODULES[i].id === id) return C.MODULES[i]; return null; };
  C.pricingImpactText = function (m) {
    if (!m) return null;
    return { impact: m.pricing_impact ? 'YES' : 'NO', text: m.pricing_impact ? 'MOVES THE LINE' : 'RESEARCH CONTEXT ONLY',
      maturity: C.MATURITY[m.maturity] ? C.MATURITY[m.maturity].label : m.maturity, reason: m.reason };
  };

  /* =================================================================
     WHAT PRICES THIS GAME? — the production pricing inputs of the CFB
     champion, from the engine's actual configuration. `terms` are the
     game's own additive contributions (engine contributions / terminal
     why.rows); anything not in the champion's priced set is listed with
     the reason it is not priced.
     ================================================================= */
  C.PRICED_TERMS = {
    rating: 'Trained team state (production pricing state, both teams)',
    hfa: 'Home field (league constant, 4.08 pts; 0 at a neutral site)',
    matchup: 'Validated stylistic matchup (play-level efficiency)',
    conference: 'Cross-conference strength (prior season, decays to 0 by 6 games)',
    schedule: 'Schedule stress (rest, road stretch, look-ahead)',
    injury: 'Reported quarterback absence (3.90 pts, only when reported)'
  };
  C.UNPRICED = [
    { key: 'etsr', label: 'Current FBS power rating (ETSR)', reason: 'shadow research: point scale not yet calibrated' },
    { key: 'player_quality', label: 'Player quality', reason: 'research only: walk-forward validation not yet passed' },
    { key: 'personnel', label: 'Non-QB personnel absences', reason: 'research only: coefficient not trained (0.0 pts)' },
    { key: 'qb_quality', label: 'Quarterback quality (EPA per dropback)', reason: 'research only: the published college series is not on the scale the coefficient was fitted on' },
    { key: 'travel', label: 'Travel', reason: 'rejected by validation: coefficients reversed sign out of sample (0 pts)' },
    { key: 'rivalry', label: 'Rivalry', reason: 'rejected by validation: raised held-out MAE (0 pts)' },
    { key: 'weather', label: 'Weather', reason: 'shown only: no historical weather series earned a coefficient' },
    { key: 'v2', label: 'V2.1 challenger', reason: 'shadow: graded beside V1, prices nothing' },
    { key: 'market', label: 'Sportsbook market', reason: 'comparison only — never an input to the pure fair line' }
  ];
  C.pricingInputs = function (terms, opts) {
    opts = opts || {};
    var by = {};
    (terms || []).forEach(function (t) { if (t && t.key) by[t.key] = t; });
    var rows = [];
    Object.keys(C.PRICED_TERMS).forEach(function (k) {
      var t = by[k], pts = t ? num(t.points) : null;
      var on = k === 'rating' || k === 'hfa' || k === 'matchup' || k === 'conference' || k === 'schedule' || (k === 'injury' && pts != null && pts !== 0);
      rows.push({ key: k, label: C.PRICED_TERMS[k], priced: true, active: on, points: pts == null ? (k === 'injury' ? 0 : null) : r2(pts),
        /* a note never repeats the number beside it; a term with no stored
           value says so instead of printing an empty cell */
        note: k === 'injury' && !(pts) ? 'no quarterback absence reported for this game'
          : (k === 'hfa' && opts.neutral ? 'neutral site'
          : (pts == null ? 'not among this game’s stored terms (0 pts)' : null)) });
    });
    rows.push({ key: 'absorption', label: 'Current-season score + efficiency absorption', priced: true, active: true, points: null,
      note: 'every completed game updates the team state before this projection' });
    C.UNPRICED.forEach(function (u) {
      var r = { key: u.key, label: u.label, priced: false, active: false, points: null, note: u.reason };
      if (u.key === 'etsr' && opts.canonical_mode === 'PRICED_CANONICAL') { r.priced = true; r.active = true; r.note = 'promoted: supplies the Layer-1 mean'; }
      rows.push(r);
    });
    return { rows: rows, independence: C.INDEPENDENCE.headline, model_version: opts.model_version || 'edgedesk_cfb_p4_v1.0.0' };
  };

  /* =================================================================
     COUNTERS — one hierarchy, every counter defined. Population,
     threshold, sport and status stated for each, so nobody has to
     reverse-engineer a number.
     ================================================================= */
  C.COUNTERS = {
    ALL_GAMES: { label: 'ALL GAMES', sport: 'NFL + CFB', population: 'every pregame game on the board inside the lookahead window', threshold: 'none', status: 'any',
      means: 'Every upcoming game on the board: NFL games in the lookahead window, plus every game with an FBS team once the college slate is loaded.' },
    RESEARCH_READY: { label: 'RESEARCH READY', sport: 'NFL + CFB', population: 'ALL GAMES', threshold: 'a PREDICTED projection and a usable current market', status: 'not DATA FAULT, NO MARKET or LIMITED DATA',
      means: 'Games with sufficient football data and a usable market state for research.' },
    ACTIONABLE: { label: 'ACTIONABLE RESEARCH SIGNALS', sport: 'NFL + CFB', population: 'RESEARCH READY', threshold: '2+ pt model–market gap that cleared every research gate', status: 'VERIFIED MAJOR or WORTH RESEARCHING',
      means: 'Research-ready games with a disagreement worth opening that cleared every gate. Research, not bets: none is a decision.' },
    VERIFIED_MAJOR: { label: 'VERIFIED MAJOR', sport: 'CFB', population: 'CFB research ready', threshold: '7+ pts', status: 'VERIFIED MAJOR DISAGREEMENT',
      means: '7+ point model–market disagreement that passed the full integrity gate.' },
    INVESTIGATE: { label: 'INVESTIGATE', sport: 'CFB', population: 'CFB research ready', threshold: '7+ pts', status: 'INVESTIGATE + MARKET FAULT',
      means: 'Large disagreement that has not cleared the integrity gate (including gaps the market is too thin to verify).' },
    WORTH_RESEARCHING: { label: 'WORTH RESEARCHING', sport: 'CFB', population: 'CFB research ready', threshold: '2–7 pts', status: 'WORTH RESEARCHING',
      means: '2–7 point disagreement at a fresh market with usable confidence and reliability.' },
    MARKET_ALIGNED: { label: 'MARKET ALIGNED', sport: 'CFB', population: 'CFB research ready', threshold: 'under 2 pts', status: 'MARKET ALIGNED + NEAR PICK’EM',
      means: 'EdgeDesk and the market within 2 points (near pick’em games included).' },
    NO_MARKET_LIMITED: { label: 'NO MARKET / LIMITED', sport: 'CFB', population: 'CFB games', threshold: '—', status: 'NO MARKET + LIMITED DATA',
      means: 'No usable current quote, or EdgeDesk cannot trust its own number enough to research the gap.' },
    DATA_FAULT: { label: 'DATA FAULT', sport: 'CFB', population: 'CFB games', threshold: '—', status: 'DATA FAULT',
      means: 'A data problem makes EdgeDesk’s number unsafe until explained.' }
  };
  C.CFB_BUCKET = { VERIFIED_MAJOR: 'VERIFIED_MAJOR', INVESTIGATE: 'INVESTIGATE', MARKET_FAULT: 'INVESTIGATE', WORTH_RESEARCHING: 'WORTH_RESEARCHING',
    NEAR_PICKEM: 'MARKET_ALIGNED', MARKET_ALIGNED: 'MARKET_ALIGNED', NO_MARKET: 'NO_MARKET_LIMITED', LIMITED_DATA: 'NO_MARKET_LIMITED', DATA_FAULT: 'DATA_FAULT' };
  C.READY_STATUSES = ['VERIFIED_MAJOR', 'INVESTIGATE', 'MARKET_FAULT', 'WORTH_RESEARCHING', 'NEAR_PICKEM', 'MARKET_ALIGNED'];
  C.ACTIONABLE_STATUSES = ['VERIFIED_MAJOR', 'WORTH_RESEARCHING'];
  /* rows: [{sport:'cfb'|'nfl', research_status:key}] */
  C.counterHierarchy = function (rows) {
    var h = { all: 0, ready: 0, actionable: 0, by_sport: {}, cfb_buckets: {}, reconciles: true };
    Object.keys(C.COUNTERS).forEach(function (k) { if (C.COUNTERS[k].sport === 'CFB') h.cfb_buckets[k] = 0; });
    (rows || []).forEach(function (r) {
      var sp = r.sport === 'p4' ? 'cfb' : (r.sport || 'other'), k = r.research_status;
      h.all++;
      var s = h.by_sport[sp] || (h.by_sport[sp] = { total: 0, ready: 0, actionable: 0 });
      s.total++;
      if (C.READY_STATUSES.indexOf(k) >= 0) { h.ready++; s.ready++; }
      if (C.ACTIONABLE_STATUSES.indexOf(k) >= 0) { h.actionable++; s.actionable++; }
      if (sp === 'cfb' && C.CFB_BUCKET[k]) h.cfb_buckets[C.CFB_BUCKET[k]]++;
    });
    var cfb = h.by_sport.cfb ? h.by_sport.cfb.total : 0, sum = 0;
    Object.keys(h.cfb_buckets).forEach(function (k) { sum += h.cfb_buckets[k]; });
    h.reconciles = sum === cfb;
    return h;
  };

  /* =================================================================
     THE SIX QUESTIONS a research page answers in 10–15 seconds.
     ================================================================= */
  C.SIX_QUESTIONS = [
    { key: 'edgedesk', q: 'What does EdgeDesk make the game?' },
    { key: 'market', q: 'What does the market make it?' },
    { key: 'why', q: 'Why do they differ?' },
    { key: 'confidence', q: 'How confident is EdgeDesk?' },
    { key: 'risk', q: 'What could make EdgeDesk wrong?' },
    { key: 'price', q: 'At what price does the research become interesting?' }
  ];

  /* =================================================================
     POSTMORTEM CLASSES — one vocabulary for losses, wins and misses
     ================================================================= */
  C.POSTMORTEM = {
    GOOD_PROCESS_BAD_OUTCOME: 'GOOD PROCESS / BAD OUTCOME', GOOD_PROCESS_GOOD_OUTCOME: 'GOOD PROCESS / GOOD OUTCOME',
    BAD_PROCESS_GOOD_OUTCOME: 'BAD PROCESS / GOOD OUTCOME', BAD_MODEL: 'BAD MODEL', BAD_DATA: 'BAD DATA', BAD_PRICE: 'BAD PRICE',
    NORMAL_VARIANCE: 'NORMAL VARIANCE', UNRESOLVED: 'UNRESOLVED'
  };

  return freeze(C);
});

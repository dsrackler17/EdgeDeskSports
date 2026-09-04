/* ===========================================================================
   EdgeDesk Games — Price It scoring.

   THE FORMULA, in one line:

       score = max(0, 100 - 10 * ceil(max(0, d - 1)))

   where `d` is the absolute distance, in points, between the price the player
   locked and the benchmark price.

   In words: you keep all 100 points as long as you are within a point. After
   that you lose 10 points for every further point of difference, rounded up to
   the next whole point. It reaches 0 at 11 points away and never goes negative.

   It reproduces the product's published bands exactly:

       0.0 – 1.0 away = 100      2.5 – 3.0 = 80
       1.5 – 2.0 away =  90      3.5 – 4.0 = 70   ... and so on

   WHY THESE PROPERTIES MATTER
   * Deterministic. Same inputs, same score, forever — no clock, no random, no
     model call. A score written to history can be recomputed and audited.
   * Understandable. A player can do it in their head, which is the whole point
     of a score that is meant to feel fair.
   * Versioned. Every stored result carries SCORING_VERSION. If the formula ever
     changes, old results keep their old version and are NEVER silently
     rescored; a reader can always tell which rule produced a number.

   WHAT THE SCORE IS NOT
   The benchmark is not "the right answer". EdgeDesk's own projection does not
   beat the closing line (see football/cfb_p4/research/report/BACKTEST.md), and
   the market is not truth either. The score measures AGREEMENT with a stated
   benchmark, and the copy around it must never call a player wrong for
   disagreeing.

   BENCHMARKS
   'edgedesk' (default) — EdgeDesk's projected spread. This is an EdgeDesk game;
                          the interesting question is how your read compares to
                          the research model's.
   'market'             — the book number, when one has joined the game.
   'close'              — RESERVED. Closing lines are not carried in the
                          challenge artifact today. The field exists so a
                          "Closing Line Score" can be added later WITHOUT
                          rescoring anything already stored; nothing in V1
                          computes it.
   =========================================================================== */
(function (root) {
  'use strict';

  var SCORING_VERSION = 'price_it_v1';
  var FREE_POINTS = 1;      /* full marks inside this distance */
  var STEP_PENALTY = 10;    /* points lost per whole point beyond it */
  var MAX_SCORE = 100;

  var BENCHMARKS = ['edgedesk', 'market', 'close'];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* Distance in points between two spreads on the SAME convention.
     Every spread in this product is the HOME team's line (home favoured by
     3 is -3), so a plain difference is the honest distance. */
  function distance(a, b) {
    if (!isNum(a) || !isNum(b)) return null;
    /* rounded to a tenth: spreads are half-point quantities, and a stored
       distance of 1.6999999999999993 would print and compare badly forever */
    return Math.round(Math.abs(a - b) * 10) / 10;
  }

  /* The formula. `d` is a distance in points. */
  function scoreForDistance(d) {
    if (!isNum(d) || d < 0) return null;
    var over = Math.max(0, d - FREE_POINTS);
    /* rounded to a tenth first: a distance of 1.0000000000000002 from float
       arithmetic must not cost ten points */
    over = Math.round(over * 10) / 10;
    return Math.max(0, MAX_SCORE - STEP_PENALTY * Math.ceil(over));
  }

  /* Score one locked price against one benchmark value. */
  function score(userSpread, benchmarkSpread) {
    var d = distance(userSpread, benchmarkSpread);
    if (d == null) return null;
    return scoreForDistance(d);
  }

  /* ── The full result of one Price It challenge ──────────────────────────
     Returns everything the reveal screen and the share card need, computed
     once, deterministically, from values the challenge artifact already
     carried. It invents no number: `edgedesk` and `market` come in from the
     artifact and go out untouched.

     `userSpread` is the HOME team's line as the player set it. */
  function evaluate(opts) {
    opts = opts || {};
    var user = opts.userSpread;
    var edge = isNum(opts.edgedesk) ? opts.edgedesk : null;
    var mkt = isNum(opts.market) ? opts.market : null;
    var benchmark = opts.benchmark || 'edgedesk';
    if (BENCHMARKS.indexOf(benchmark) < 0) benchmark = 'edgedesk';
    /* 'close' is reserved and carries no value in V1 — fall back rather than
       score against nothing. */
    if (benchmark === 'close') benchmark = 'edgedesk';
    if (benchmark === 'market' && mkt == null) benchmark = 'edgedesk';
    if (benchmark === 'edgedesk' && edge == null && mkt != null) benchmark = 'market';

    var benchVal = benchmark === 'market' ? mkt : edge;
    if (!isNum(user) || !isNum(benchVal)) {
      return { ok: false, reason: 'no benchmark price available for this matchup',
        scoring_version: SCORING_VERSION };
    }

    var dEdge = distance(user, edge);
    var dMkt = distance(user, mkt);

    return {
      ok: true,
      scoring_version: SCORING_VERSION,
      benchmark: benchmark,
      user_spread: user,
      edgedesk_spread: edge,
      market_spread: mkt,
      distance: distance(user, benchVal),
      score: scoreForDistance(distance(user, benchVal)),
      /* both distances travel with the result so the reveal can show the one
         it did not score against, and so a future benchmark switch can be
         audited rather than recomputed */
      distance_to_edgedesk: dEdge,
      distance_to_market: dMkt,
      score_vs_edgedesk: dEdge == null ? null : scoreForDistance(dEdge),
      score_vs_market: dMkt == null ? null : scoreForDistance(dMkt),
      /* model-versus-market is the artifact's number, not the player's */
      edgedesk_vs_market: (isNum(edge) && isNum(mkt)) ? Math.round((edge - mkt) * 10) / 10 : null
    };
  }

  /* ── Plain-language comparison, never a verdict ─────────────────────────
     "You priced Auburn 1.7 points lower than EdgeDesk." The player is never
     described as wrong: they are described as different, with a direction.

     `homeTeam` / `awayTeam` name the sides so the sentence reads like football
     rather than like signed arithmetic. Spreads are the HOME line, so a MORE
     NEGATIVE user number means the player likes the home team MORE. */
  function compare(userSpread, benchSpread, benchLabel, homeTeam, awayTeam) {
    if (!isNum(userSpread) || !isNum(benchSpread)) return null;
    var d = Math.round(Math.abs(userSpread - benchSpread) * 10) / 10;
    if (d === 0) return 'You priced this exactly where ' + benchLabel + ' does.';
    var side = userSpread < benchSpread ? (homeTeam || 'the home team') : (awayTeam || 'the away team');
    return 'You gave ' + side + ' ' + d.toFixed(1) + ' more point' + (d === 1 ? '' : 's')
      + ' than ' + benchLabel + '.';
  }

  /* A short, honest label for a score. No praise inflation, no "you beat the
     market" — the score measures agreement, and the words say only that. */
  function band(score) {
    if (!isNum(score)) return null;
    if (score >= 100) return { key: 'dead_on', label: 'Dead on' };
    if (score >= 80) return { key: 'close', label: 'Close read' };
    if (score >= 60) return { key: 'near', label: 'In the neighbourhood' };
    if (score >= 30) return { key: 'apart', label: 'Different read' };
    return { key: 'far', label: 'Way apart' };
  }

  /* ── Pick 5 settlement ──────────────────────────────────────────────────
     Which side covered, from the FINAL SCORE and the spread the card was
     actually submitted against. Deterministic, and it uses the player's own
     stored line rather than whatever the market moved to afterwards — a card
     is graded on the number it was picked at.

     `homeSpread` is the HOME team's line (home favoured by 7 is -7). The home
     side covers when the home margin beats the points it laid:

         margin + homeSpread > 0   ->  home
         margin + homeSpread < 0   ->  away
         exactly 0                 ->  push

     Returns null when anything needed is missing, so an ungraded game stays
     ungraded instead of being guessed. */
  function atsResult(homeSpread, homeScore, awayScore) {
    if (!isNum(homeSpread) || !isNum(homeScore) || !isNum(awayScore)) return null;
    var v = Math.round(((homeScore - awayScore) + homeSpread) * 100) / 100;
    if (v > 0) return 'home';
    if (v < 0) return 'away';
    return 'push';
  }

  var API = {
    SCORING_VERSION: SCORING_VERSION,
    atsResult: atsResult,
    FREE_POINTS: FREE_POINTS, STEP_PENALTY: STEP_PENALTY, MAX_SCORE: MAX_SCORE,
    BENCHMARKS: BENCHMARKS,
    distance: distance, scoreForDistance: scoreForDistance, score: score,
    evaluate: evaluate, compare: compare, band: band
  };
  root.EDGamesScoring = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

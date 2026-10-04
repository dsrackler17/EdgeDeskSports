/* ===========================================================================
   EdgeDesk Games — how a Head-to-Head is graded.

   Pure functions over (two selections, a market snapshot, a final score). No
   clock, no network, no randomness: the same inputs always produce the same
   outcome, which is what lets a settled challenge be re-derived and audited
   long afterwards.

   WHERE THIS RUNS
     Authoritatively in games/settle_h2h.js, the worker that holds the service
     role and calls h2h_settle(). The pages import it only to EXPLAIN a result
     the server already recorded — a browser cannot settle anything, because
     h2h_settle is granted to no client role.

   THE THREE MODES
     winner    whoever picked the side that actually won. Both right or both
               wrong is impossible (there are two sides), so the only draw is
               a tied final score.
     spread    settled against the line SNAPSHOTTED when the challenge was
               created, never a number the market moved to afterwards. A push
               is a DRAW: neither player beat it.
     price_it  each player set a fair line; whoever landed closer to the
               benchmark wins, using the published Price It scoring rule. Equal
               distance is a DRAW.

   NOBODY IS CALLED WRONG for disagreeing with EdgeDesk. In price_it the
   benchmark is the closing market number where one exists, and EdgeDesk's
   projection only when it does not — and the result says which was used.
   =========================================================================== */
(function (root) {
  'use strict';

  var SC = root.EDGamesScoring
    || (typeof require === 'function' ? require('./scoring.js') : null);

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* 'win' means PLAYER A wins. The caller flips for B. */
  function flip(o) { return o === 'win' ? 'loss' : o === 'loss' ? 'win' : 'draw'; }

  /* ── winner ───────────────────────────────────────────────────────────── */
  function gradeWinner(selA, selB, homeScore, awayScore) {
    if (!selA || !selB || !isNum(homeScore) || !isNum(awayScore)) return null;
    if (homeScore === awayScore) {
      return { outcome_a: 'draw', reason: 'the game finished level', winning_side: null };
    }
    var winner = homeScore > awayScore ? 'home' : 'away';
    var aRight = selA.side === winner, bRight = selB.side === winner;
    /* both players on the same side is possible if a client ever allowed it;
       grading stays honest rather than assuming they differ */
    var outcome = aRight === bRight ? 'draw' : (aRight ? 'win' : 'loss');
    return { outcome_a: outcome, winning_side: winner,
      reason: aRight === bRight
        ? 'both players picked the same side'
        : 'the ' + winner + ' side won' };
  }

  /* ── spread ───────────────────────────────────────────────────────────── */
  /* `homeSpread` is the SNAPSHOT from the challenge, the home team's line. */
  function gradeSpread(selA, selB, homeSpread, homeScore, awayScore) {
    if (!selA || !selB || !SC) return null;
    var covered = SC.atsResult(homeSpread, homeScore, awayScore);
    if (!covered) return null;
    if (covered === 'push') {
      return { outcome_a: 'draw', covered: 'push',
        reason: 'the game landed exactly on the locked line — a push is a draw' };
    }
    var aRight = selA.side === covered, bRight = selB.side === covered;
    var outcome = aRight === bRight ? 'draw' : (aRight ? 'win' : 'loss');
    return { outcome_a: outcome, covered: covered,
      reason: aRight === bRight
        ? 'both players picked the same side'
        : 'the ' + covered + ' side covered the locked line' };
  }

  /* ── price it ─────────────────────────────────────────────────────────── */
  /* Each selection carries { spread }. The benchmark is the closing market
     number when the settlement supplies one, otherwise EdgeDesk's projection —
     and the result records which, so a player can always see what they were
     measured against. */
  function gradePriceIt(selA, selB, benchmarks) {
    if (!selA || !selB || !SC) return null;
    var b = benchmarks || {};
    var value = isNum(b.close) ? b.close : (isNum(b.market) ? b.market : b.edgedesk);
    var basis = isNum(b.close) ? 'closing line' : (isNum(b.market) ? 'market' : 'EdgeDesk projection');
    if (!isNum(value) || !isNum(selA.spread) || !isNum(selB.spread)) return null;

    var dA = SC.distance(selA.spread, value), dB = SC.distance(selB.spread, value);
    var sA = SC.scoreForDistance(dA), sB = SC.scoreForDistance(dB);
    var outcome = dA === dB ? 'draw' : (dA < dB ? 'win' : 'loss');
    return {
      outcome_a: outcome,
      benchmark: value, benchmark_basis: basis,
      distance_a: dA, distance_b: dB, score_a: sA, score_b: sB,
      reason: dA === dB
        ? 'both players landed the same distance from the ' + basis
        : 'closer to the ' + basis + ' by ' + (Math.round(Math.abs(dA - dB) * 10) / 10) + ' points'
    };
  }

  /* ── the one entry point the worker uses ──────────────────────────────── */
  /* `challenge` is the row as h2h_view returns it; `result` is the canonical
     final { home_score, away_score } plus an optional closing line. Returns
     null when the inputs cannot settle anything, so an ungradeable challenge
     is left alone rather than guessed at. */
  function grade(challenge, selA, selB, result) {
    if (!challenge || !selA || !selB || !result) return null;
    var hs = result.home_score, as = result.away_score;
    var snap = challenge.market_snapshot || {};
    var g = null;
    if (challenge.mode === 'winner') {
      g = gradeWinner(selA, selB, hs, as);
    } else if (challenge.mode === 'spread') {
      /* the SNAPSHOT, never a live number */
      g = gradeSpread(selA, selB, snap.spread, hs, as);
    } else if (challenge.mode === 'price_it') {
      g = gradePriceIt(selA, selB, {
        close: result.closing_spread,
        market: snap.spread,
        edgedesk: snap.edgedesk
      });
    }
    if (!g) return null;
    return {
      outcome_a: g.outcome_a,
      outcome_b: flip(g.outcome_a),
      score_a: g.score_a == null ? null : g.score_a,
      score_b: g.score_b == null ? null : g.score_b,
      evidence: Object.assign({ home_score: hs, away_score: as, mode: challenge.mode }, g)
    };
  }

  var API = {
    flip: flip, gradeWinner: gradeWinner, gradeSpread: gradeSpread,
    gradePriceIt: gradePriceIt, grade: grade
  };
  root.EDGamesH2HGrade = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ===========================================================================
   EdgeDesk Games — the research state.

   THIS FILE DEFINES NOTHING. It re-derives the state the research terminal
   already assigns to a matchup (app.html `fbGxState`) from the SAME source of
   truth: the thresholds shipped in football/cfb_p4/params.js, plus the guard
   bound the Power 4 board polices.

       THIN DATA     the model does not trust its own number here
       NO MARKET     no book number has joined, so there is nothing to compare
       INVESTIGATE   disagreement past the guard bound — missing information is
                     likelier than an opportunity
       REVIEW        enough disagreement to justify research, not a proven edge
       PASS          effectively in agreement

   The ordering matters and is the terminal's, not a new opinion: THIN DATA
   outranks everything, because a number the model does not trust cannot be in
   agreement OR in disagreement with anyone.

   tools/games/state_parity.test.js reads `fbGxState` straight out of app.html
   and asserts this module returns the same key for the same input, so the two
   cannot drift apart without a test going red.
   =========================================================================== */
(function (root) {
  'use strict';

  /* The guard bound the Power 4 board applies to a game-level disagreement.
     Mirrors FB_GUARD.p4.game in app.html. */
  var GUARD_POINTS = 21;

  function params() {
    return (root.EDCfbP4Params) || (typeof global !== 'undefined' && global.window
      && global.window.EDCfbP4Params) || null;
  }

  function thresholds() {
    var P = params() || {}, MP = P.market || {};
    return {
      min_gap: MP.min_research_gap != null ? MP.min_research_gap : 2,
      min_confidence: MP.min_confidence != null ? MP.min_confidence : 35,
      guard: GUARD_POINTS
    };
  }

  /* `confidence` is the engine's own 0-100 confidence in the projection.
     `gap` is model spread minus market spread, in points (sign irrelevant). */
  function classify(confidence, gap, T) {
    T = T || thresholds();
    var conf = (typeof confidence === 'number' && isFinite(confidence)) ? confidence : null;
    var g = (typeof gap === 'number' && isFinite(gap)) ? Math.abs(gap) : null;

    if (conf == null || conf < T.min_confidence) {
      return { key: 'THIN', label: 'Thin data', tone: 'neg',
        means: 'EdgeDesk does not have enough reliable information to price this matchup '
          + 'confidently yet. Read the number as provisional, not as a disagreement with anyone.' };
    }
    if (g == null) {
      return { key: 'NO_MARKET', label: 'No market', tone: 'mut',
        means: 'No book number has joined this game yet, so there is nothing to agree or '
          + 'disagree with. The projection stands on its own until a quote lands.' };
    }
    if (g >= T.guard) {
      return { key: 'INVESTIGATE', label: 'Investigate', tone: 'neg',
        means: 'EdgeDesk and the market are ' + g.toFixed(1) + ' points apart, past the '
          + T.guard + '-point guard bound. Missing or stale information is more likely than a '
          + 'hidden opportunity until the gap is explained.' };
    }
    if (g >= T.min_gap) {
      return { key: 'REVIEW', label: 'Review', tone: 'warn',
        means: 'EdgeDesk differs from the market by ' + g.toFixed(1) + ' points — enough to '
          + 'justify deeper research, but the disagreement has not been validated as a betting edge.' };
    }
    return { key: 'PASS', label: 'Pass', tone: 'ok',
      means: 'EdgeDesk and the market are effectively in agreement — ' + g.toFixed(1)
        + ' points apart, inside the ' + T.min_gap + '-point research threshold.' };
  }

  /* The one-line prompt that turns a state into curiosity about the research,
     without ever claiming a disagreement is an edge. */
  function invitation(key) {
    switch (key) {
      case 'INVESTIGATE': return 'Large disagreement. More research required.';
      case 'REVIEW': return 'Enough disagreement to be worth reading the research.';
      case 'PASS': return 'EdgeDesk and the market land in the same place. See why.';
      case 'NO_MARKET': return 'No book number yet — the projection stands on its own.';
      case 'THIN': return 'EdgeDesk is short of trustworthy inputs here. See what is missing.';
      default: return 'See what EdgeDesk sees.';
    }
  }

  var API = {
    GUARD_POINTS: GUARD_POINTS,
    thresholds: thresholds, classify: classify, invitation: invitation
  };
  root.EDGamesResearchState = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

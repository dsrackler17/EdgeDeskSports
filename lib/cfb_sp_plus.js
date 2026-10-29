/* ===========================================================================
   EdgeDesk CFB — SP+ as an EXTERNAL estimate (browser + node, ES5, pure).
   football/sp_plus/README.md

   SP+ is ESPN's opponent-adjusted efficiency rating, created by Bill
   Connelly. EdgeDesk shows a line derived from it beside its own fair spread.
   It is a second opinion, never an input: nothing here is read by EdgeDesk's
   model, EV, rankings or grades.

   PROVENANCE
     SP+ rating            T3 Research Model, external (not EdgeDesk's, not
                           validated by EdgeDesk)
     SP+ projected line    T2 Computed: the deterministic transform below

   THE PROJECTION (cfb_sp_projection_v1)
     home margin = home SP+ − away SP+ + home field     (0 at a neutral site)
     The home field is the one EdgeDesk's CFB engine applies
     (football/cfb_p4/home_field.js through the engine; the build records the
     value and its source). Stored at 0.01, shown at 0.1. A margin is home
     minus away (+ = home favoured); a home line is the book's sign
     (− = home favoured).

   Never combined with EdgeDesk's number: the two sit side by side, and a
   difference of DISAGREE_PTS or more is said in plain words.
   =========================================================================== */
(function (root) {
  'use strict';
  var V = {
    VERSION: 'edgedesk_cfb_sp_plus/1',
    RULE: 'cfb_sp_projection_v1',
    FORM: 'home SP+ − away SP+ + home field (0 at a neutral site)',
    DISAGREE_PTS: 3,
    LABEL: 'SP+ projection',
    ATTRIBUTION: 'Projection derived from SP+ (ESPN, Bill Connelly). Data provided by CollegeFootballData.com.',
    TIER: { rating: 'T3', line: 'T2', text: 'T3 external model · T2 computed line', external: true, edgedesk_model: false }
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  /* to 0.01, and never a negative zero */
  function r2(x) { var v = Math.round(x * 100) / 100; return v === 0 ? 0 : v; }

  /* the T2 transform: pure and deterministic, no clock, no randomness */
  V.projectHomeMargin = function (homeSp, awaySp, neutral, hfa) {
    if (!isNum(homeSp) || !isNum(awaySp)) return null;
    if (!neutral && !isNum(hfa)) return null;
    return r2(homeSp - awaySp + (neutral ? 0 : hfa));
  };
  V.homeLine = function (margin) { return isNum(margin) ? r2(-margin) : null; };

  /* "Middle Tennessee −1.3": the line named for its own favourite, at 0.1 */
  V.lineText = function (home, away, margin) {
    if (!isNum(margin)) return null;
    var m = Math.round(margin * 10) / 10;
    if (m === 0) return 'Pick’em';
    return (m > 0 ? home : away) + ' −' + Math.abs(m).toFixed(1);
  };

  /* EdgeDesk's home margin against SP+'s: the size of the gap, and whether it
     reaches the plain-words threshold. Never an average of the two. */
  V.disagreement = function (edgedeskMargin, spMargin) {
    if (!isNum(edgedeskMargin) || !isNum(spMargin)) return null;
    var pts = r2(Math.abs(edgedeskMargin - spMargin));
    return { points: pts, disagree: pts >= V.DISAGREE_PTS };
  };

  root.EDCfbSpPlus = V;
  if (typeof module !== 'undefined' && module.exports) module.exports = V;
})(typeof window !== 'undefined' ? window : globalThis);

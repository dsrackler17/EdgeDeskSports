/* ============================================================================
   THE REGIME-CHANGE SIGNAL — one definition, shared by the walk-forward fit
   (football/cfb_p4/research/regime_backtest.js), the current-season builder
   (football/coaching/build_regime.js) and the tests.

   A programme is in a REGIME CHANGE when its long-run pricing state is
   describing a team that no longer exists: a NEW HEAD COACH (the tenure
   began this season) AND a roster that turned over more than a typical
   programme's did that season. Continuity is compared WITHIN the season
   (percentiles among that season's FBS teams), because the level drifts with
   the portal: P4 returning share fell from 0.67 to 0.43 in a decade.

     fires  = new_hc === true
              AND ( returning roster share  <= season median
                 OR returning production    <= season median
                 OR transfers out           >= season 75th percentile
                 OR no continuity measurement at all )

   A coach change with NO continuity measurement fires on the coach change
   alone. That is the conservative direction on purpose: the flag BLOCKS a
   research label (lib/edgedesk_canon.js), it never creates one. An unknown
   coach change (null) never fires: silence is not a regime change either.

   Node and browser (UMD). No dependencies.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDRegimeSignal = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var DEFAULT = {
    id: 'cfb_regime_signal_v1',
    continuity_pct_max: 0.5,
    transfers_out_pct_min: 0.75,
    definition: 'new head coach (tenure began this season) AND (returning roster share or returning production '
      + 'at or below the season FBS median, OR transfers out at or above the season 75th percentile); a coach '
      + 'change with no continuity measurement fires on the coach change alone'
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function pctText(p) { return isNum(p) ? ordinal(Math.round(100 * p)) + ' percentile' : 'unmeasured'; }

  /* x = { new_hc, returning_share_pct, returning_production_pct, transfers_out_pct } */
  function fires(x, sig) {
    sig = sig || DEFAULT;
    if (!x || x.new_hc !== true) {
      return { fires: false, reason: x && x.new_hc === false ? 'same head coach as last season'
        : 'whether the head coach changed is unknown, and an unknown change is not a regime change' };
    }
    var parts = [], measured = false;
    function low(v, label) {
      if (!isNum(v)) return;
      measured = true;
      if (v <= sig.continuity_pct_max) parts.push(label + ' at the ' + pctText(v));
    }
    low(x.returning_share_pct, 'returning roster share');
    low(x.returning_production_pct, 'returning production');
    if (isNum(x.transfers_out_pct)) {
      measured = true;
      if (x.transfers_out_pct >= sig.transfers_out_pct_min) parts.push('transfers out at the ' + pctText(x.transfers_out_pct));
    }
    if (!measured) return { fires: true, reason: 'new head coach; roster continuity is not measured, so the coach change alone fires' };
    return parts.length ? { fires: true, reason: 'new head coach; ' + parts.join('; ') }
      : { fires: false, reason: 'new head coach, but most of the roster and production returned (continuity above the season median)' };
  }

  /* percentile rank (0..1, ties averaged) of each value among the numbers in `values` */
  function percentiles(values) {
    var xs = values.filter(isNum).slice().sort(function (a, b) { return a - b; });
    return function (v) {
      if (!isNum(v) || xs.length < 20) return null;
      var below = 0, eq = 0, i;
      for (i = 0; i < xs.length; i++) { if (xs[i] < v) below++; else if (xs[i] === v) eq++; }
      return (below + (eq + 1) / 2) / xs.length;
    };
  }

  /* the curve, as fitted (football/cfb_p4/regime_curve.js): capped by the standard curve */
  function weight(gamesPlayed, standardWeight, curve) {
    if (!curve || !isNum(curve.w0) || !isNum(curve.lambda) || !isNum(standardWeight)) return null;
    var g = isNum(gamesPlayed) ? Math.max(0, gamesPlayed) : 0;
    return Math.min(standardWeight, curve.w0 * Math.exp(-curve.lambda * g));
  }

  return { DEFAULT: DEFAULT, fires: fires, percentiles: percentiles, weight: weight };
});

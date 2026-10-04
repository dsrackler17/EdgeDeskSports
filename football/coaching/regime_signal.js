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

  /* ==========================================================================
     THE REGIME MAGNITUDE (v2, audit 2026-09-30 follow-up). The flag above is
     a yes/no: Iowa State (4th-percentile returning production, last year's QB
     gone, 128% of its production imported) and Virginia Tech (36th percentile,
     a coach change) got the same 69% long-run weight at four games. The
     magnitude is a CONTINUOUS turnover index over four measured inputs, each
     a hinge that is zero at or better than the season's typical programme:

        f_coach = 1 if the head coach's tenure began this season, else 0
                  (an unknown change is 0, as for the flag)
        f_prod  = max(0, 1 − 2·returning_production_pct)   (0 at the median)
        f_qb    = 1 if the quarterback who started the team's last game is not
                  last season's primary QB (before its first game: he is not on
                  the roster), 0 if he is or if that is unknown
        f_port  = max(0, 2·incoming_production_pct − 1)    (0 at the median)
                  incoming = production-weighted portal inflow: what the
                  arrivals produced last season at another programme

        m = a_coach·f_coach + a_prod·f_prod + a_qb·f_qb + a_port·f_port
        w = w_standard(g) · exp(−m)

     The coefficients are FITTED walk-forward on 2021+ seasons only
     (football/cfb_p4/research/regime_magnitude_backtest.js) and shipped in
     football/cfb_p4/regime_curve.js. m = 0 is the standard curve exactly, so
     a programme with typical-or-better continuity and the same coach and QB
     is priced as before; the magnitude can only CUT the long-run weight.
     Percentiles are within the season among FBS programmes, like the flag's.
     An UNMEASURED input is 0: silence is not turnover, and the magnitude only
     ever cuts the long-run weight on evidence.
     ========================================================================== */
  var MAGNITUDE_INPUTS = ['coach', 'prod', 'qb', 'port'];
  function hingeLow(p) { return isNum(p) ? Math.max(0, Math.min(1, 1 - 2 * p)) : 0; }
  function hingeHigh(p) { return isNum(p) ? Math.max(0, Math.min(1, 2 * p - 1)) : 0; }
  /* x = { new_hc, returning_production_pct, qb_change, incoming_production_pct } */
  function magnitudeFeatures(x) {
    x = x || {};
    return {
      coach: x.new_hc === true ? 1 : 0,
      prod: hingeLow(x.returning_production_pct),
      qb: x.qb_change === true ? 1 : 0,
      port: hingeHigh(x.incoming_production_pct)
    };
  }
  /* coef = { coach, prod, qb, port } (fitted); returns { m, features, terms } */
  function magnitude(x, coef) {
    if (!coef) return null;
    var f = magnitudeFeatures(x), terms = {}, m = 0, i, k;
    for (i = 0; i < MAGNITUDE_INPUTS.length; i++) {
      k = MAGNITUDE_INPUTS[i];
      terms[k] = (isNum(coef[k]) ? coef[k] : 0) * f[k];
      m += terms[k];
    }
    return { m: m, features: f, terms: terms };
  }
  function magnitudeWeight(standardWeight, m) {
    if (!isNum(standardWeight) || !isNum(m)) return null;
    return standardWeight * Math.exp(-Math.max(0, m));
  }

  return { DEFAULT: DEFAULT, fires: fires, percentiles: percentiles, weight: weight,
    MAGNITUDE_INPUTS: MAGNITUDE_INPUTS, magnitudeFeatures: magnitudeFeatures, magnitude: magnitude,
    magnitudeWeight: magnitudeWeight };
});

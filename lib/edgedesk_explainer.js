/* ============================================================================
   THE DISAGREEMENT EXPLAINER (audit 2026-09-30 follow-up #3).

   A research label says HOW LARGE a model-market disagreement is and whether
   it survived the integrity gate. It does not say WHY. This file splits a
   gap into the parts that, walk-forward, the closing market has
   systematically discounted in EdgeDesk's own number — and the rest, which
   is UNEXPLAINED by anything measured.

       gap        G = fair home margin − market home margin
       terms      x_k, each an exact piece of the engine's projection (below)
       fitted     β_k, OLS of G on x over 2021-2023 FBS games against the close
                  (tools/football/explainer_fit.js), holdout 2024-2025
       explained  e_k = β_k · x_k  (the part of this gap the market has
                  historically taken out of this term), plus the intercept
       unexplained  G − intercept − Σ e_k

   THE TERMS (home minus away, points; every one read off the projection,
   none from the market):
     rating      the opponent-adjusted rating contribution (the scale of the
                 rating gap: does the market compress large ones?)
     prior       the long-run share of it: w·(long-run − this season − track
                 offset) per side — how much of the rating rests on LAST
                 season beyond what this season's (centred) track says
     turnover    prior × the side's turnover index (the mean of its four v2
                 magnitude features, football/coaching/regime_signal.js): the
                 long-run share on a turned-over roster
     home_field  the engine's home-field term (a league constant, 0 neutral)
     qb_change   (home QB change) − (away QB change), 0/1 each: a new starter
                 the market prices and the engine's QB term (usually
                 unavailable) does not
     conference  the conference-strength term
     matchup     the stylistic matchup term
     other       travel + schedule + injury + rivalry

   A β near 0 means the market has not discounted that term (it agrees with
   EdgeDesk's use of it); a β near 1 means it has discounted all of it. The
   explanation is a DESCRIPTION of historical disagreement, never a price:
   nothing here moves a line, and the market is not an input to any rating.

   Node and browser (UMD). No dependencies.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDExplainer = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'edgedesk_disagreement_explainer_v1';
  var TERMS = ['rating', 'prior', 'turnover', 'home_field', 'qb_change', 'conference', 'matchup', 'other'];
  var LABEL = {
    rating: 'rating-gap scale', prior: 'last season’s share of the rating', turnover: 'last season’s share on a turned-over roster',
    home_field: 'home field (engine constant)', qb_change: 'quarterback change', conference: 'conference strength',
    matchup: 'stylistic matchup', other: 'travel, schedule, injuries, rivalry'
  };
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }
  function contrib(p, key) {
    var c = (p && p.contributions) || [], i;
    for (i = 0; i < c.length; i++) if (c[i] && c[i].key === key) return isNum(c[i].points) && c[i].available !== false ? c[i].points : 0;
    return 0;
  }
  function turnoverIndex(features) {
    if (!features) return 0;
    var k = ['coach', 'prod', 'qb', 'port'], s = 0, i;
    for (i = 0; i < k.length; i++) s += isNum(features[k[i]]) ? features[k[i]] : 0;
    return s / k.length;
  }

  /* x from an engine projection (football/cfb_p4/engine.js projectGame) and
     each side's turnover record ({features, qb_change}; football/coaching/
     regime.json by_team.<key> carries both: magnitude.features, qb_change) */
  function termsFromProjection(p, sides) {
    if (!p || p.status !== 'PREDICTED' || !p.layers || !p.layers.strength) return null;
    var S = p.layers.strength, B = S.preseason_blend || {}, tc = S.track_centres || null;
    var off = tc && tc.available && isNum(tc.offset) ? tc.offset : null;
    function share(side) {
      var w = B[side + '_prior_weight'], c = B[side + '_carried'], f = B[side + '_this_season'];
      if (!isNum(w) || !isNum(c) || !isNum(f)) return null;
      return w * (c - f - (off != null ? off : 0));
    }
    var ph = share('home'), pa = share('away');
    sides = sides || {};
    var th = turnoverIndex(sides.home && sides.home.features), ta = turnoverIndex(sides.away && sides.away.features);
    var qh = sides.home && sides.home.qb_change === true ? 1 : 0, qa = sides.away && sides.away.qb_change === true ? 1 : 0;
    return {
      version: VERSION,
      rating: contrib(p, 'rating'),
      prior: ph != null && pa != null ? ph - pa : 0,
      turnover: ph != null && pa != null ? th * ph - ta * pa : 0,
      home_field: contrib(p, 'hfa'),
      qb_change: qh - qa,
      conference: contrib(p, 'conference'),
      matchup: contrib(p, 'matchup'),
      other: contrib(p, 'travel') + contrib(p, 'schedule') + contrib(p, 'injury') + contrib(p, 'rivalry'),
      measured: { track_offset: off, prior_available: ph != null && pa != null, turnover_index: { home: th, away: ta },
        qb_change: { home: sides.home ? sides.home.qb_change : null, away: sides.away ? sides.away.qb_change : null } }
    };
  }

  /* the explanation of ONE gap. fit = the artifact's `explainer`
     ({intercept, coef:{k: β}, se:{k}, holdout:{...}}) */
  function explain(terms, fairMargin, marketMargin, fit, names) {
    if (!terms || !isNum(fairMargin) || !isNum(marketMargin)) return { available: false, why: 'a projection and a market are both needed' };
    if (!fit || !fit.coef) return { available: false, why: 'the explainer fit (football/validation/disagreement_explainer.json) is not loaded' };
    var gap = fairMargin - marketMargin, parts = [], sum = isNum(fit.intercept) ? fit.intercept : 0;
    TERMS.forEach(function (k) {
      var b = fit.coef[k], x = terms[k];
      if (!isNum(x)) return;
      /* a term the fit could not measure is SHOWN with no discount: its whole
         size stays in the unexplained part rather than being guessed away */
      if (!isNum(b)) { if (Math.abs(x) >= 0.005) parts.push({ key: k, label: LABEL[k], term_points: r2(x), discount: null, explained_points: 0, significant: false, unfitted: true }); return; }
      var e = b * x;
      sum += e;
      parts.push({ key: k, label: LABEL[k], term_points: r2(x), discount: r2(b), explained_points: r2(e),
        significant: !!(fit.significant && fit.significant[k]) });
    });
    parts.sort(function (a, b) { return Math.abs(b.explained_points) - Math.abs(a.explained_points); });
    var un = gap - sum, H = names && names.home, A = names && names.away;
    function toward(v) { return v > 0 ? (H || 'home') : (v < 0 ? (A || 'away') : null); }
    return {
      available: true, version: VERSION, fit_version: fit.version || null,
      gap_points: r2(gap), toward: toward(gap),
      intercept_points: r2(fit.intercept), explained_points: r2(sum), unexplained_points: r2(un), unexplained_toward: toward(un),
      share_explained: Math.abs(gap) > 0.05 ? r2(Math.max(0, Math.min(1, 1 - Math.abs(un) / Math.abs(gap)))) : null,
      parts: parts,
      caveat: 'A description of how the closing market has historically discounted each piece of EdgeDesk’s number '
        + '(fit ' + (fit.fitted_on || '?') + ', holdout R² ' + (fit.holdout && isNum(fit.holdout.r2) ? fit.holdout.r2.toFixed(2) : '?') + '). It explains, it never prices.'
    };
  }

  return { VERSION: VERSION, TERMS: TERMS, LABEL: LABEL, termsFromProjection: termsFromProjection, explain: explain, turnoverIndex: turnoverIndex };
});

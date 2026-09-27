/* ===========================================================================
   EdgeDesk CFB RELIABILITY — a data-quality, uncertainty and projection-
   stability score for ONE college game, 0-100.

   WHAT IT ANSWERS. "How much can EdgeDesk trust the completeness, freshness,
   internal consistency and stability of the information underneath this
   projection?" Nothing else. It is NOT:

     - confidence. The engine's information confidence (scores.confidence)
       weighs the evidence behind the number; this scores the inputs, their
       ages, whether their sources agree, and whether the number survives
       reasonable changes to what is uncertain. The two are computed apart,
       published apart, and allowed to disagree: High confidence with Low
       reliability is a real and different object from the reverse;
     - a probability. A reliability of 90 does NOT mean a 90% chance the
       projection is right, and nothing here may be printed as one;
     - a betting signal. It moves no projection, no fair spread, no total and
       no win probability. It never reads a result or a closing line.

   WHY IT REPLACED THE OLD NUMBER. Reliability used to be `input_coverage`
   from the input contract (football/matchup/contract.js summarise): an
   UNWEIGHTED COUNT of applicable contract fields on file. Six fields fail on
   nearly every FBS game for one systemic reason each (availability x2 behind
   a closed provider endpoint, qb_availability x2 with no source, off_field x2
   with no registered source), so 65 of 129 games read exactly 20/26 = 77% and
   the live board, which often holds three fewer fields at load, printed 65%.
   A count moves in steps of one field whatever the field is worth, and it
   could not see stability, staleness or disagreement at all.

   THE SCORE. Six independently inspectable components, each a list of named
   items with the points they earned and, for every point lost, the specific
   reason and — where one exists — the action that would recover it:

     team_data              20   is each team actually rated, on what sample
     roster_availability    20   who plays QB and can he, who else is out
     projection_stability   20   does the number survive its own uncertainty
     freshness              15   how old is each input, against its own clock
     source_integrity       15   do the sources agree, do identities resolve
     environment            10   where, indoors or out, travel, rest

   raw = the sum of the component scores (no base score: every point is
   earned). Then HARD GATES cap it — an unknown starting quarterback, an
   unrated opponent, a model self-check failure, an unstable projection — so
   one fault can never be averaged away by a pile of full columns. Items that
   do not arise for this game (weather under a roof, travel at a neutral site,
   a market this artifact never joined) leave the denominator and the
   component is rescaled over what applies: absence of a question is never a
   penalty, and absence of an ANSWER always is.

   PURE. No clock (the caller passes `now`), no I/O, no page. The same input
   always yields the same output; tools/football/reliability.test.js pins it.

   Browser: window.EDCfbReliability.  Node: require('./cfb_reliability.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCfbReliability = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var R = { version: 'cfb_reliability/2' };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r2(x) { return Math.round(x * 100) / 100; }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function ms(t) {
    if (t == null || t === '') return null;
    var x = typeof t === 'number' ? t : Date.parse(t);
    return isFinite(x) ? x : null;
  }
  function normKey(s) { return s == null ? null : (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '') || null); }
  function hrs(h) {
    if (h == null) return 'an unknown time';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min';
    if (h < 48) return (Math.round(h * 10) / 10) + 'h';
    return (Math.round(h / 24 * 10) / 10) + ' days';
  }
  function trim(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    var cut = s.search(/[.;—]\s/);
    if (cut > 20 && cut < (n || 140)) s = s.slice(0, cut);
    return s.length > (n || 140) ? s.slice(0, (n || 140) - 1).replace(/\s+\S*$/, '') + '…' : s;
  }

  /* ------------------------------------------------------------- the rules
     Every threshold is here, named, with where it comes from. A number that
     is this layer's own choice says so. */
  R.CONFIG = {
    weights: { team_data: 20, roster_availability: 20, projection_stability: 20,
      freshness: 15, source_integrity: 15, environment: 10 },
    /* the published grades. Descriptive bands, NOT probabilities */
    grades: [
      { min: 90, key: 'VERY_STRONG', label: 'VERY STRONG' },
      { min: 80, key: 'STRONG', label: 'STRONG' },
      { min: 70, key: 'ADEQUATE', label: 'ADEQUATE' },
      { min: 60, key: 'CAUTION', label: 'CAUTION' },
      { min: 50, key: 'LOW', label: 'LOW' },
      { min: 0, key: 'VERY_LOW', label: 'VERY LOW' }
    ],
    /* the three-tier view older consumers read (lib/cfb_research_view.js
       STRONG / ADEQUATE / LOW, lib/research_priority.js TRUST). The LOW bar
       stays at 60 — the same bar input coverage used (limited_coverage 0.6),
       so LOW RELIABILITY still fires under 60 and nowhere else */
    legacy: { strong: 80, adequate: 60 },
    /* engine constants read, never re-fitted: games_for_full_confidence is
       params.rating.games_for_full_confidence (6) when params are supplied */
    full_sample_games: 6,
    stability: {
      /* THE PERTURBATION DESIGN. 32 Halton points in as many dimensions as
         there are uncertain terms, each mirrored (antithetic), so the scenario
         set is fixed, symmetric around the published number and identical on
         every machine. z is clipped at +/-2.5 so one extreme draw cannot
         define the spread. */
      halton_points: 32, z_clip: 2.5,
      /* A favourite FLIP is a scenario whose margin names the other team by
         at least the engine's own near-pick'em floor (fairLine.FLOOR = 1):
         a 0.3-point lean becoming a 0.3-point lean the other way has not
         changed its conclusion, a 3-point favourite becoming a 1-point dog
         has. */
      flip_floor: 1,
      /* the tiers, in points of spread dispersion. This layer's own bands,
         anchored on EdgeDesk's research threshold (2 pts, params
         market.min_research_gap) and the field goal:
           VERY STABLE  sd <= 1.5 and flips <= 2%   well inside the research gap
           STABLE       sd <= 2.5 and flips <= 10%  about the research gap
           MODERATE     sd <= 4.0 and flips <= 25%  past it, inside a field goal+
           UNSTABLE     anything more                the number is not settled */
      tiers: [
        { key: 'VERY_STABLE', label: 'VERY STABLE', sd: 1.5, flip: 0.02 },
        { key: 'STABLE', label: 'STABLE', sd: 2.5, flip: 0.10 },
        { key: 'MODERATE', label: 'MODERATE', sd: 4.0, flip: 0.25 }
      ],
      /* points: 14 from dispersion and 6 from favourite flips. Dispersion is
         piecewise on the tier bounds — full credit while VERY STABLE, 10.5 at
         the edge of STABLE, 4 at the edge of MODERATE, none at 6 pts — so the
         points can never disagree with the tier printed beside them. Flips:
         full at none, nothing at 25%+ */
      sd_curve: [[1.5, 14], [2.5, 10.5], [4.0, 4], [6.0, 0]], sd_points: 14,
      flip_zero: 0.25, flip_points: 6,
      very_unstable_flip: 0.35, very_unstable_sd: 6.0
    },
    freshness: {
      /* hours. Each input is aged against its own clock, never a shared one */
      model_state: [24, 72, 168],     /* rating state: full / 2/3 / 1/3, past a week stale */
      player_layer: [168, 336],       /* the player production layer: a week, two weeks */
      roster: [168, 336],             /* the contract calls a roster STALE past 14 days */
      availability: [36, 72],         /* an availability read: a day and a half, three days */
      qb_retrieved: 36,               /* the starter record was re-read inside this */
      qb_observed: 216,               /* and describes a game inside nine days */
      weather: [12, 24],              /* the contract calls a forecast STALE past 12h */
      weather_horizon: 168,           /* no forecast is meaningful further out than a week */
      market: [1, 3, 6, 24]           /* the engine flags odds stale past 6h (dataQuality) */
    },
    caps: {
      data_fault: 20, identity_conflict: 40, thin_data: 59, missing_critical: 59,
      /* the quarterback severity ladder: nobody identified, a contested job,
         and a known starter nobody has said can play */
      qb_unknown_one: 69, qb_unknown_both: 59, qb_contested: 79, qb_status_unconfirmed: 89, roster_conflict: 69,
      unstable: 79, very_unstable: 69, stability_unmeasured: 79,
      stale_core: 69, stale_roster: 79, future_data: 59
    },
    /* ranking-layer team gates (football/rankings/current.json teams[].gates)
       that say something about a team's record the games-played sample does
       not: a sample built mostly against FCS opponents. THIN_OFFENSIVE_DATA
       and THIN_DEFENSIVE_DATA are NOT read — early in a season they fire on
       every programme and restate the games-played sample already scored */
    thin_team_gates: ['FCS_DOMINATED_SAMPLE'],
    /* the FCS bridge (football/enrichment/fcs): a priced floor is
       CORROBORATED when it lies inside this many of the bridged rating's own
       standard deviations */
    fcs: { corroborate_sd: 1.0 },
    next_actions_max: 6
  };
  R.config = function (over) {
    if (!over) return R.CONFIG;
    var o = JSON.parse(JSON.stringify(R.CONFIG)), k;
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k) && over[k] != null) o[k] = over[k];
    return o;
  };

  /* ============================================ PROJECTION STABILITY
     Does the number survive reasonable changes to what is uncertain in it?

     The engine's mean is EXACTLY additive: fair_spread = the sum of its
     published contributions (projectGame: fairSpread += pts(term)). So
     perturbing an input that enters one term linearly is perturbing that
     term, and the perturbation runs on the published terms rather than on a
     hundred re-runs of the engine — the same arithmetic in the build, on the
     board and on a server, cheap enough for every game on every load.
     tools/football/reliability.test.js proves the equivalence against a
     real engine re-run.

     THE 1-SIGMA OF EACH DIMENSION comes from uncertainty the system already
     publishes; none is fitted here:

       rating (each team)  sqrt(sample^2 + blend^2)
           sample = (1 - c) x step: the engine's rating-sample confidence
                    c = games / games_for_full_confidence (clamped .15..1,
                    engine ratingGap), times the size of one more game's
                    update, step = (w k + (1-w) k_fresh) x sigma_base — the
                    engine's own learning rates and game-level noise
           blend  = half the local range of the learned prior-weight curve
                    (params.blend.prior_weight_by_week) at this team's games
                    played, times how far the carried prior and this
                    season's own track disagree about the team
         a side priced from the shared FCS floor: half the gap between the
         engine's two defaults for an unobserved team (init_rating and
         fcs_rating) — one floor number is not a rating of the team
       every other priced term (home field, matchup, injury, conference,
         schedule, rivalry, QB)
           (1 - its own confidence) x |its points|: a term the engine trusts
           at confidence c is allowed to move by (1 - c) of itself at 1 sigma

     NOT PERTURBED, and said so: travel and weather move no point (their
     layers were not validated), and the college QB term prices nothing
     until the starter layer has an out-of-sample record — so QB uncertainty
     cannot move this number and is carried by roster_availability instead.

     o = { params, blend: {home, away} }  blend = engine
         strength.blendedRating(state, key, isFbs, week) per side: {value,
         prior_weight, carried, this_season, games_played}. Absent, the
         projection's own layers.strength.preseason_blend is read. */
  var DIM_ORDER = ['rating_home', 'rating_away', 'hfa', 'matchup', 'injury', 'conference', 'schedule', 'rivalry', 'qb'];
  var DIM_LABEL = {
    rating_home: 'home team rating', rating_away: 'away team rating', hfa: 'home-field estimate',
    matchup: 'stylistic matchup', injury: 'priced injuries', conference: 'conference strength',
    schedule: 'schedule stress', rivalry: 'rivalry effect', qb: 'quarterback term'
  };
  var PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];
  function halton(i, b) { var f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }
  /* inverse normal CDF (Acklam), deterministic arithmetic only */
  function probit(p) {
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    var b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    var c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    var d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    var q, rr;
    if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; rr = q * q;
    return (((((a[0] * rr + a[1]) * rr + a[2]) * rr + a[3]) * rr + a[4]) * rr + a[5]) * q / (((((b[0] * rr + b[1]) * rr + b[2]) * rr + b[3]) * rr + b[4]) * rr + 1);
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function curveW(curve, g) {
    if (!curve) return null;
    var k = String(clamp(Math.round(g), 0, 15)), w = num(curve[k]);
    return w == null ? num(curve['15']) : w;
  }
  function contribution(p, key) {
    var cs = (p && p.contributions) || [];
    for (var i = 0; i < cs.length; i++) if (cs[i] && cs[i].key === key) return cs[i];
    return null;
  }
  function teamSigma(side, b, fbs, P, cfg, fx) {
    var hp = (P && P.rating && P.rating.hyperparams) || {};
    if (fbs === false || (b && b.basis === 'FCS bucket')) {
      /* with a bridged rating of this team, the priced floor's own error is
         measured: its distance from the team's rating and that rating's
         uncertainty, sqrt(gap^2 + sd^2). It can be tighter than the default
         (a team the floor fits) or far wider (a team it does not) */
      if (fx && num(fx.team_rating) != null && num(fx.rating_sd) != null) {
        var fl = num(fx.floor) != null ? fx.floor : num(hp.fcs_rating);
        var gp = Math.abs(fl - fx.team_rating), sg = Math.sqrt(gp * gp + fx.rating_sd * fx.rating_sd);
        return { sigma: sg, parts: { fcs_floor_gap: r2(gp), fcs_rating_sd: r2(fx.rating_sd) },
          basis: 'priced from the shared FCS floor (' + fl + '); the FCS bridge rates this team ' + r1(fx.team_rating) + ' ± '
            + r1(fx.rating_sd) + ', so the priced value is ' + r1(gp) + ' pts from it (root-mean-square error ' + r1(sg) + ')' };
      }
      var init = num(hp.init_rating), floor = num(hp.fcs_rating);
      var s = (init != null && floor != null) ? Math.abs(init - floor) / 2 : 8;
      return { sigma: s, parts: { fcs_floor: s },
        basis: 'priced from the shared FCS floor rating; half the gap between the engine’s two defaults for an unobserved team (init_rating ' + init + ', fcs_rating ' + floor + ')' };
    }
    if (!b) return { sigma: null, parts: {}, basis: 'no blended rating supplied for the ' + side + ' side' };
    var g = num(b.games_played) == null ? 0 : b.games_played;
    var w = num(b.prior_weight) == null ? 1 : clamp(b.prior_weight, 0, 1);
    var k = num(hp.k) == null ? 0.14 : hp.k, kf = num(hp.k_fresh) == null ? k : hp.k_fresh;
    var sb = num(P && P.uncertainty && P.uncertainty.sigma_base) || num(P && P.distributions && P.distributions.sigma_margin) || 14.6;
    var full = num(P && P.rating && P.rating.games_for_full_confidence) || cfg.full_sample_games;
    var c = clamp(g / full, 0.15, 1);
    var step = (w * k + (1 - w) * kf) * sb;
    var sample = (1 - c) * step;
    var curve = P && P.blend && P.blend.prior_weight_by_week;
    var wl = curveW(curve, Math.max(0, g - 1)), wh = curveW(curve, g + 1);
    var sw = (wl != null && wh != null) ? Math.abs(wl - wh) / 2 : 0;
    var dis = (num(b.carried) != null && num(b.this_season) != null) ? Math.abs(b.carried - b.this_season) : 0;
    var blend = sw * dis;
    return { sigma: Math.sqrt(sample * sample + blend * blend),
      parts: { sample: r2(sample), blend: r2(blend), games: g, prior_weight: r2(w), prior_vs_season: r2(dis) },
      basis: g + ' game' + (g === 1 ? '' : 's') + ' absorbed (sample confidence ' + r2(c) + ' of a one-game update of ' + r2(step)
        + ' pts); prior and this-season tracks ' + r1(dis) + ' pts apart, curve slope ' + r2(sw) };
  }
  function curvePts(curve, x) {
    if (x <= curve[0][0]) return curve[0][1];
    for (var i = 1; i < curve.length; i++) {
      if (x <= curve[i][0]) {
        var a = curve[i - 1], b = curve[i];
        return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      }
    }
    return curve[curve.length - 1][1];
  }
  R.stability = function (p, o, over) {
    var cfg = R.config(over), S = cfg.stability;
    o = o || {};
    var P = o.params || null;
    if (!p || p.status !== 'PREDICTED' || !p.model || num(p.model.fair_spread) == null) {
      return { measured: false, reason: 'no valid projection to perturb' + (p && p.status ? ' (' + p.status + ')' : '') };
    }
    var cs = p.contributions || [];
    if (!cs.length) return { measured: false, reason: 'the projection carries no additive terms to perturb' };
    var m = p.model.fair_spread;
    var pb = (p.layers && p.layers.strength && p.layers.strength.preseason_blend) || {};
    var bl = o.blend || {};
    var bh = bl.home || (num(pb.home_carried) != null ? { carried: pb.home_carried, this_season: pb.home_this_season,
      prior_weight: pb.prior_weight, games_played: pb.games_played } : null);
    var ba = bl.away || (num(pb.away_carried) != null ? { carried: pb.away_carried, this_season: pb.away_this_season,
      prior_weight: pb.prior_weight, games_played: pb.games_played } : null);
    var fbs = o.fbs || {};
    var fcsEv = o.fcs || {};
    var dims = [], notPerturbed = [];
    var rating = contribution(p, 'rating');
    if (rating && rating.available) {
      [['home', bh, fbs.home], ['away', ba, fbs.away]].forEach(function (x) {
        var t = teamSigma(x[0], x[1], x[2], P, cfg, fcsEv[x[0]] || null);
        if (t.sigma != null && t.sigma > 0) dims.push({ key: 'rating_' + x[0], sign: x[0] === 'home' ? 1 : -1,
          sigma: t.sigma, label: DIM_LABEL['rating_' + x[0]], basis: t.basis, parts: t.parts });
      });
    }
    ['hfa', 'matchup', 'injury', 'conference', 'schedule', 'rivalry', 'qb'].forEach(function (key) {
      var c = contribution(p, key);
      if (!c || !c.available || num(c.points) == null || c.points === 0) {
        if (key === 'qb') notPerturbed.push({ key: 'qb', why: 'the college QB term prices nothing (no EPA feed on the fitted scale; the starter layer has no out-of-sample record yet), so a different starter cannot move this number — QB uncertainty is scored under roster/availability instead' });
        return;
      }
      var conf = num(c.confidence) == null ? 0.5 : clamp(c.confidence, 0, 1);
      var sg = (1 - conf) * Math.abs(c.points);
      if (sg > 0) dims.push({ key: key, sign: 1, sigma: sg, label: DIM_LABEL[key],
        basis: r2(c.points) + ' pts at engine confidence ' + r2(conf) });
    });
    notPerturbed.push({ key: 'travel', why: 'travel moves no point: every travel specification raised error out of sample, so the layer is published and not applied' });
    notPerturbed.push({ key: 'weather', why: 'weather moves no point on the spread: no weather coefficient was earned on this corpus' });
    dims.sort(function (a, b) { return DIM_ORDER.indexOf(a.key) - DIM_ORDER.indexOf(b.key); });
    var N = S.halton_points, margins = [], i, j;
    for (i = 1; i <= N; i++) {
      var shift = 0;
      for (j = 0; j < dims.length; j++) {
        var z = clamp(probit(halton(i, PRIMES[j % PRIMES.length])), -S.z_clip, S.z_clip);
        shift += dims[j].sign * dims[j].sigma * z;
      }
      margins.push(m + shift, m - shift);
    }
    var mean = 0; margins.forEach(function (x) { mean += x; }); mean /= margins.length;
    var v = 0; margins.forEach(function (x) { v += (x - mean) * (x - mean); }); v /= margins.length;
    var sd = Math.sqrt(v);
    var side = m > 0 ? 1 : (m < 0 ? -1 : (p.model.display_side === 'away' ? -1 : 1));
    var flips = margins.filter(function (x) { return (x * side) <= -S.flip_floor; }).length;
    var flip = flips / margins.length;
    var sorted = margins.slice().sort(function (a, b) { return a - b; });
    var tier = null, k;
    for (k = 0; k < S.tiers.length; k++) if (sd <= S.tiers[k].sd && flip <= S.tiers[k].flip) { tier = S.tiers[k]; break; }
    var tierKey = tier ? tier.key : 'UNSTABLE', tierLabel = tier ? tier.label : 'UNSTABLE';
    var sdPts = curvePts(S.sd_curve, sd);
    var flPts = S.flip_points * clamp(1 - flip / S.flip_zero, 0, 1);
    var top = dims.slice().sort(function (a, b) { return b.sigma - a.sigma; })[0] || null;
    return {
      measured: true,
      method: 'deterministic perturbation: ' + margins.length + ' scenarios (' + N + ' Halton points, mirrored) over '
        + dims.length + ' uncertain term' + (dims.length === 1 ? '' : 's') + ' of the engine’s additive projection',
      n_scenarios: margins.length,
      base_margin: r2(m),
      projection_stability_sd: r2(sd),
      projection_p10: r2(quantile(sorted, 0.10)),
      projection_p50: r2(quantile(sorted, 0.50)),
      projection_p90: r2(quantile(sorted, 0.90)),
      favorite_flip_rate: r3(flip),
      flip_rule: 'a scenario whose margin names the other team by ' + S.flip_floor + '+ pt',
      tier: tierKey, tier_label: tierLabel,
      projection_stability_score: r1(sdPts + flPts),
      points: { dispersion: r1(sdPts), flips: r1(flPts) },
      dimensions: dims.map(function (d) { return { key: d.key, label: d.label, sigma: r2(d.sigma), basis: d.basis, parts: d.parts || null }; }),
      largest: top ? { key: top.key, label: top.label, sigma: r2(top.sigma) } : null,
      not_perturbed: notPerturbed
    };
  };

  /* ================================================= SCORING HELPERS */
  function Ctx(input, cfg) {
    this.in = input; this.cfg = cfg;
    this.now = ms(input.now);
    this.game = input.game || {};
    this.p = input.projection || null;
    var rows = input.contract || [];
    this.rows = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]; if (!r || !r.field) continue;
      this.rows[r.field + ':' + (r.side || '-')] = r;
    }
    this.hasContract = rows.length > 0;
    /* THE EVIDENCE PACKAGE (lib/game_evidence.js), when the caller has one.
       Its availability read and its quarterback status REPLACE the contract's
       rows for those two fields, so every item below reads ONE
       interpretation: fixture-scoped, source-ranked, never a report for
       another game, never a historical row read as today's fitness */
    this.ev = input.evidence && input.evidence.schema === 'edgedesk_game_evidence_v1' ? input.evidence : null;
    if (this.ev) {
      var self = this;
      ['home', 'away'].forEach(function (side) {
        var ar = evAvailabilityRow(self.ev, side); if (ar) self.rows['availability:' + side] = ar;
        var qr = evQbStatusRow(self.ev, side); if (qr) self.rows['qb_availability:' + side] = qr;
        /* the starter layer marks a job split by usage as CONFLICTING sources;
           the resolver separates a split job (scored as contested) from
           sources that contradict each other (scored as conflicted) */
        var sr = self.rows['qb_starter:' + side], q = self.ev.quarterback && self.ev.quarterback[side];
        if (sr && q) {
          var want = q.confirmation_level === 'CONFLICTED' ? 'CONFLICTING' : (sr.state === 'CONFLICTING' ? 'RESEARCH_ONLY' : sr.state);
          if (want !== sr.state) { var cp = {}, f; for (f in sr) cp[f] = sr[f]; cp.state = want; cp.detail = (q.resolution_text || sr.detail || null); self.rows['qb_starter:' + side] = cp; }
        }
      });
    }
    this.gates = [];
    this.notes = [];
  }
  /* the evidence class in the contract's vocabulary — the same map
     lib/game_evidence.js publishes as CLASS_TO_STATE (the test pins them) */
  R.EVIDENCE_CLASS_TO_STATE = {
    COMPREHENSIVE_OFFICIAL: 'USABLE', OFFICIAL_THIS_GAME: 'USABLE', MULTI_SOURCE_CURRENT: 'USABLE',
    STRUCTURED_CURRENT: 'USABLE', OFFICIAL_ABSENCE_ONLY: 'RESEARCH_ONLY', STALE_CARRIED: 'STALE',
    NOT_DUE_YET: 'NOT_DUE_YET', NOT_REQUIRED: 'NOT_REQUIRED', PROVIDER_FAILED: 'FETCH_FAILED', NO_SOURCE: 'UNAVAILABLE'
  };
  function evAvailabilityRow(ev, side) {
    var a = ev.availability && ev.availability[side];
    if (!a || !a.coverage_class) return null;
    return { field: 'availability', side: side, state: R.EVIDENCE_CLASS_TO_STATE[a.coverage_class] || 'UNAVAILABLE',
      source: 'evidence ' + a.coverage_class, as_of: a.as_of || (a.official && a.official.published_at) || null,
      observed_at: (a.official && a.official.published_at) || a.as_of || null, detail: a.coverage_reason,
      evidence_class: a.coverage_class };
  }
  function evQbStatusRow(ev, side) {
    var q = ev.quarterback && ev.quarterback[side], a = ev.availability && ev.availability[side];
    if (!q) return null;
    var st;
    if (q.status && q.status !== 'UNKNOWN') st = q.status_fresh === false ? 'STALE' : 'USABLE';
    else if (a && a.coverage_class === 'NOT_DUE_YET') st = 'NOT_DUE_YET';
    else if (a && a.coverage_class === 'NOT_REQUIRED') st = 'NOT_REQUIRED';
    else st = 'UNAVAILABLE';
    return { field: 'qb_availability', side: side, state: st, source: 'evidence QB resolver', detail: q.status_basis || null,
      designation: q.status || 'UNKNOWN' };
  }
  Ctx.prototype.row = function (field, side) { return this.rows[field + ':' + (side || '-')] || null; };
  /* PRICED FROM THE SHARED FCS FLOOR — a statement about the DATA (no rating
     of this team exists in the pricing state), never about the division: an
     FCS programme the state actually rates is scored on its rating like any
     other, and the gate follows the data, not the conference's reputation */
  Ctx.prototype.floorPriced = function (side) {
    var row = this.row('team_rating', side);
    var b = this.in.blend && this.in.blend[side];
    if (b && b.basis === 'FCS bucket') return true;
    if (row) return row.state !== 'USABLE';
    return this.fbs(side) === false;
  };
  Ctx.prototype.team = function (side) {
    var g = this.game;
    return (side === 'home' ? (g.home || g.home_team) : (g.away || g.away_team)) || (side === 'home' ? 'the home team' : 'the away team');
  };
  Ctx.prototype.fbs = function (side) {
    var g = this.game, v = side === 'home' ? g.home_fbs : g.away_fbs;
    if (v === true || v === false) return v;
    var d = side === 'home' ? g.home_division : g.away_division;
    if (d) return String(d).toLowerCase() === 'fbs';
    var row = this.row('team_rating', side);
    return row ? !/FCS|outside the rated FBS/i.test(String(row.detail || '')) : true;
  };
  /* the age of a row, judged NOW. A timestamp later than the judging time
     cannot have been known then: it is refused, and gated */
  Ctx.prototype.age = function (t) {
    var x = ms(t);
    if (x == null || this.now == null) return null;
    return (this.now - x) / 3600e3;
  };
  Ctx.prototype.gate = function (id, cap, reason, action, key) {
    this.gates.push({ id: id, cap: cap, reason: reason, action: action || null, action_key: key || null });
  };
  function item(id, label, max, earned, o) {
    o = o || {};
    var na = o.na === true;
    return { id: id, label: label, max: max, earned: na ? 0 : r2(clamp(earned, 0, max)),
      state: na ? 'NOT_APPLICABLE' : (o.state || (earned >= max - 1e-9 ? 'FULL' : (earned <= 1e-9 ? 'MISSING' : 'PARTIAL'))),
      reason: o.reason || null, action: o.action || null, action_key: o.action_key || null,
      family: o.family || (o.action_key ? String(o.action_key).split(':')[0] : null),
      missing: o.missing || null };
  }

  /* ================================================= A. TEAM DATA (20) */
  function teamData(c) {
    var items = [], cfg = c.cfg, p = c.p;
    var tq = c.in.team_quality || {};
    var full = num(c.in.full_sample_games) || cfg.full_sample_games;
    var bl = c.in.blend || {};
    var pb = (p && p.layers && p.layers.strength && p.layers.strength.preseason_blend) || {};
    var unratedSides = [];
    ['home', 'away'].forEach(function (side) {
      var name = c.team(side), row = c.row('team_rating', side), fbs = c.fbs(side);
      var usable = !c.floorPriced(side) && (row ? row.state === 'USABLE' : !!(p && p.status === 'PREDICTED'));
      if (!usable) {
        /* THE FCS BRIDGE (football/enrichment/fcs). The engine still prices
           this side from the shared floor; the bridge is a measured rating of
           THIS team on the same scale. It earns the side credit only when it
           is STRONG and the priced floor sits inside one of its standard
           deviations — the priced number is then corroborated by evidence
           about the team, not merely assigned by division. A floor the
           evidence contradicts is not rescued by having been measured. */
        var fx = !fbs && c.ev && c.ev.team_data && c.ev.team_data[side] ? c.ev.team_data[side].fcs : null;
        if (fx && num(fx.team_rating) != null && num(fx.rating_sd) != null) {
          var gap = Math.abs(num(fx.floor) == null ? -28 - fx.team_rating : fx.floor - fx.team_rating);
          var corroborated = gap <= cfg.fcs.corroborate_sd * fx.rating_sd;
          var desc = name + ' is priced from the shared FCS floor (' + fx.floor + '); its bridged rating is ' + r1(fx.team_rating)
            + ' ± ' + r1(fx.rating_sd) + ' (' + String(fx.confidence || '').toLowerCase() + ': ' + (fx.games_sample || 0) + ' games, '
            + (fx.bridge_sample || 0) + ' against FBS)';
          if (fx.confidence === 'STRONG' && corroborated) {
            var fe = 3 + 2 * clamp((fx.games_sample || 0) / full, 0, 1) - (fx.completeness != null && fx.completeness < 0.5 ? 1 : 0);
            items.push(item('rating_' + side, name + ' team rating', 6, fe, { family: 'fcs_rating',
              reason: desc + ' — the priced floor is ' + r1(gap) + ' pts from it, inside one SD: corroborated, not priced from it' }));
            return;
          }
          unratedSides.push(name);
          items.push(item('rating_' + side, name + ' team rating', 6, 0, {
            reason: desc + (corroborated ? ' — consistent with the floor, but not yet a STRONG rating'
              : ' — the priced floor is ' + r1(gap) + ' pts from it'),
            action: 'Strengthen the FCS rating of ' + name + ' (FCS-vs-FCS results; a pricing promotion of the bridge)',
            action_key: 'fcs_rating', missing: 'team_rating:' + side }));
          return;
        }
        unratedSides.push(name);
        items.push(item('rating_' + side, name + ' team rating', 6, 0, {
          reason: fbs
            ? name + ' has no rating in the pricing state' + (row && row.detail ? ' (' + trim(row.detail, 110) + ')' : '')
            : name + ' is priced from the shared FCS floor rating — one number for every FCS programme, not a rating of this team',
          action: fbs ? 'Rate ' + name + ' in the pricing state' : 'Wire an FCS team-rating source (' + name + ')',
          action_key: fbs ? 'rate:' + side : 'fcs_rating', missing: 'team_rating:' + side }));
        return;
      }
      var gates = (tq[side] && tq[side].gates) || [];
      var b = bl[side] || null;
      var games = b && num(b.games_played) != null ? b.games_played
        : (side === 'home' && num(pb.games_played) != null ? pb.games_played : null);
      if (games == null && row && row.detail) {
        var mm = /over (\d+) absorbed game/.exec(row.detail); if (mm) games = +mm[1];
      }
      var earned = 3, bits = [];
      var noPrior = gates.indexOf('PRIOR_SEASON_MISSING') >= 0;
      if (!noPrior) earned += 1; else bits.push('no prior-season rating to carry');
      var sample = games == null ? 0.5 : clamp(games / full, 0, 1);
      earned += 2 * sample;
      if (games == null) bits.push('games absorbed not reported');
      else if (games < full) bits.push(games + ' of ' + full + ' games for a full in-season sample');
      var thin = gates.filter(function (x) { return cfg.thin_team_gates.indexOf(x) >= 0; });
      var thinCost = Math.min(1, thin.length * 1);
      earned -= thinCost;
      thin.forEach(function (x) { bits.push(x === 'FCS_DOMINATED_SAMPLE' ? 'its rating sample is dominated by FCS opponents' : x.toLowerCase().replace(/_/g, ' ')); });
      items.push(item('rating_' + side, name + ' team rating', 6, earned, {
        reason: bits.length ? name + ': ' + bits.join('; ') : null,
        action: null, family: noPrior ? 'prior_missing' : (thin.length ? 'fcs_dominated' : 'rating_sample') }));
    });
    /* matchup profile: the opponent-adjusted offence/defence pairing, at the
       share of interaction pairs the engine could actually observe */
    var mrow = c.row('matchup_profile', null), mc = contribution(p, 'matchup');
    if (mrow && mrow.state !== 'USABLE') {
      items.push(item('matchup_profile', 'offense/defense matchup profile', 4, 0, {
        reason: trim(mrow.detail || 'no measured profile for both sides', 150),
        action: 'Measure a play-level profile for both sides', action_key: 'matchup_profile', missing: 'matchup_profile' }));
      if (c.fbs('home') && c.fbs('away')) c.gate('MISSING_CRITICAL', cfg.caps.missing_critical,
        'the offense/defense matchup profile is missing between two FBS teams', 'Measure a play-level profile for both sides', 'matchup_profile');
    } else {
      var conf = mc && mc.available && num(mc.confidence) != null ? clamp(mc.confidence, 0, 1) : (mrow ? 0.75 : 0.5);
      items.push(item('matchup_profile', 'offense/defense matchup profile', 4, 4 * conf, {
        reason: conf < 0.999 ? 'the engine observed ' + Math.round(conf * 100) + '% of the matchup interaction pairs' : null }));
    }
    /* the rating state itself: valid and inside the engine's sanity bounds */
    var valid = !!(p && p.status === 'PREDICTED' && num(p.model && p.model.fair_spread) != null
      && contribution(p, 'rating') && contribution(p, 'rating').available);
    items.push(item('rating_state', 'power-rating state valid', 2, valid ? 2 : 0, {
      reason: valid ? null : 'the power-rating state did not produce a valid rating gap for this game' }));
    /* schedule/opponent context: rest and the opponent sequence */
    ['home', 'away'].forEach(function (side) {
      var r = c.row('schedule_context', side);
      if (r && r.state === 'NOT_APPLICABLE') items.push(item('schedule_' + side, c.team(side) + ' schedule context', 1, 0, { na: true }));
      else if (r && r.state === 'USABLE') items.push(item('schedule_' + side, c.team(side) + ' schedule context', 1, 1));
      else items.push(item('schedule_' + side, c.team(side) + ' schedule context', 1, 0, {
        reason: 'no schedule context resolved for ' + c.team(side), missing: 'schedule_context:' + side }));
    });
    if (unratedSides.length) c.gate('THIN_DATA', cfg.caps.thin_data,
      unratedSides.join(' and ') + (unratedSides.length > 1 ? ' are' : ' is') + ' not rated by the model (priced from a shared floor): THIN DATA, not research-grade',
      'Wire an FCS team-rating source', 'fcs_rating');
    return items;
  }

  /* ======================================== B. ROSTER / AVAILABILITY (20) */
  function qbInfo(c, side) {
    var p = c.p, I = p && p.layers && p.layers.qb && p.layers.qb.information;
    return I ? I[side] : null;
  }
  function rosterAvailability(c) {
    var items = [], cfg = c.cfg, unknownQb = [], contested = [], unconfirmed = [], conflictedQb = [];
    var starters = c.in.starters || {}, epa = c.in.qb_epa || {};
    ['home', 'away'].forEach(function (side) {
      var name = c.team(side), info = qbInfo(c, side), st = starters[side] || null;
      var comp = info && info.available && info.components ? info.components : null;
      var who = comp && comp.who_starts ? num(comp.who_starts.value) : null;
      var ident = comp && comp.identity ? num(comp.identity.value) : null;
      var status = String((st && st.status) || '').toUpperCase();
      var player = (st && (st.player_name || st.player)) || null;
      var srow = c.row('qb_starter', side);
      var isComp = status === 'COMPETITION' || (st && st.contested === true);
      /* who plays quarterback */
      if (who == null) {
        if (st && player && status && status !== 'UNKNOWN') {
          who = status === 'ANNOUNCED' ? 0.95 : (status === 'DEPTH_CHART' ? 0.9 : (status === 'EXPECTED' ? 0.8
            : (isComp ? 0.5 : 0.76)));
          ident = st.identity_corroborated === false ? 0.5 : 1;
        }
      }
      /* THE RESOLVER'S VERDICT (football/enrichment/qb), where there is an
         evidence package. The calibrated rate the engine read stays the
         probability wherever one exists; the confirmation LABEL is never
         turned into one. What the resolver adds: a starter it could not find
         in any current evidence is unknown; a job its sources contest is
         contested; a conflict its hierarchy cannot settle is CONFLICTED; a
         starter listed questionable is less likely to take the snap; and a
         ruled-out starter hands the identity to the next name it supports */
      var q = c.ev && c.ev.quarterback ? c.ev.quarterback[side] : null, lvl = q ? q.confirmation_level : null;
      var qConflicted = false, qDoubt = null;
      if (q) {
        if (lvl === 'UNKNOWN') who = null;
        else {
          if (q.player_id && st && st.player_id && String(q.player_id) !== String(st.player_id)) {
            who = num(q.starter_probability) != null ? q.starter_probability : null; ident = 1;
          } else if (who == null && num(q.starter_probability) != null) { who = q.starter_probability; if (ident == null) ident = 1; }
          /* named by evidence with no calibrated rate: the declared ladder the
             engine itself uses (ANNOUNCED .95, DEPTH_CHART .9) and the
             measured overall hold rate (.76) for an expected starter */
          if (who == null && q.player_id) { who = lvl === 'CONFIRMED' ? 0.95 : (lvl === 'STRONGLY_EXPECTED' ? 0.9 : (lvl === 'EXPECTED' ? 0.76 : 0.5)); if (ident == null) ident = 1; }
          if (lvl === 'CONFIRMED' && who < 0.95) who = 0.95;
          qConflicted = lvl === 'CONFLICTED';
          isComp = !!q.contested || qConflicted;
          var pAbs = { PROBABLE: 0.15, QUESTIONABLE: 0.5, DOUBTFUL: 0.75 }[q.status];
          if (pAbs != null && who != null) { who = who * (1 - pAbs); qDoubt = q.status; }
          player = q.player_name || player;
        }
      }
      if (who == null || who <= 0) {
        unknownQb.push(name);
        items.push(item('qb_identity_' + side, name + ' starting QB', 4, 0, {
          reason: 'no starting quarterback resolved for ' + name + (srow && srow.detail ? ' (' + trim(srow.detail, 90) + ')' : ''),
          action: 'Identify ' + name + '’s starting QB', action_key: 'qb_identity:' + side, missing: 'qb_starter:' + side }));
      } else {
        var e = 4 * who * (0.5 + 0.5 * (ident == null ? 1 : ident)) * (isComp ? 0.75 : 1);
        var confirmed = q ? lvl === 'CONFIRMED' : (status === 'ANNOUNCED' || (st && st.confirmed === true));
        var why;
        if (confirmed) why = null;
        else if (q) {
          why = (player || 'the resolved starter') + ' — ' + String(lvl).replace(/_/g, ' ').toLowerCase()
            + (q.conflict && q.resolution_text ? ' (' + trim(q.resolution_text, 150) + ')' : '')
            + (q.contested && !qConflicted ? '; the job is split by usage' : '')
            + '; ' + (num(q.starter_probability) != null ? trim(q.probability_basis, 170) : 'no calibrated rate exists for this evidence class')
            + (qDoubt ? '; listed ' + qDoubt.toLowerCase() : '')
            + (ident != null && ident < 1 ? '; identity not corroborated against the current roster' : '');
        } else why = (player ? player : 'the resolved starter') + (isComp ? ' is in an open competition'
            : (status === 'PREVIOUS_GAME' ? ' started the last game — no announcement for this one' : ' is projected, not announced'))
            + ' (the evidence class holds for the next game ' + Math.round(who * 100) + '% of the time)'
            + (ident != null && ident < 1 ? '; identity not corroborated against the current roster' : '');
        items.push(item('qb_identity_' + side, name + ' starting QB', 4, e, {
          reason: why, action: confirmed ? null : 'Confirm ' + name + '’s starting QB' + (player ? ' (' + player + ')' : ''),
          action_key: confirmed ? null : 'qb_identity:' + side }));
        if (qConflicted) conflictedQb.push({ side: side, name: name, text: q.resolution_text });
        else if (isComp) contested.push(name);
      }
      /* can he play. With an evidence package the engine's own flag is not
         read: it was set from the contract's row, which could carry a
         historical feed row as today's fitness */
      var avail = c.ev ? null : (comp && comp.available ? num(comp.available.value) : null);
      var arow = c.row('qb_availability', side);
      var aE = 0, aWhy = null, aAction = null;
      if (avail === 1 || (arow && arow.state === 'USABLE')) aE = 2;
      else if (arow && arow.state === 'STALE') {
        aE = 1; aWhy = (player || name + '’s QB') + '’s status comes from a stale read — carried, not current';
        aAction = 'Refresh ' + name + ' injury availability';
      }
      else if (arow && arow.state === 'NOT_DUE_YET') {
        aE = 1; aWhy = name + '’s availability report is not due yet — nobody is assumed fit';
        aAction = 'Re-read availability inside the filing window (' + name + ')';
      } else if (arow && arow.state === 'NOT_REQUIRED') {
        aE = 0.5; aWhy = 'no conference report is required for this fixture, so no source states whether ' + (player || name + '’s QB') + ' can play';
        aAction = 'Register a school availability release for ' + name;
      } else {
        aWhy = 'no source states whether ' + (player || name + '’s starting QB') + ' can play — silence is not health';
        aAction = 'Confirm ' + name + '’s QB availability';
      }
      if (aE < 2 && who != null && who > 0) unconfirmed.push({ side: side, name: name });
      /* the fix for "can he play" is the same availability source that
         answers the rest of the roster, so it shares that action */
      items.push(item('qb_status_' + side, name + ' QB status', 2, aE, { reason: aE < 2 ? aWhy : null,
        action: aE < 2 ? aAction : null, action_key: aE < 2 ? 'availability:' + side : null, family: 'qb_status',
        missing: aE === 0 ? 'qb_availability:' + side : null }));
      /* who else is out, weighted by what they are worth */
      items.push(nonQb(c, side));
      /* roster continuity and production attribution */
      items.push(rosterProduction(c, side, epa[side]));
    });
    if (unknownQb.length) c.gate(unknownQb.length > 1 ? 'QB_UNKNOWN_BOTH' : 'QB_UNKNOWN',
      unknownQb.length > 1 ? cfg.caps.qb_unknown_both : cfg.caps.qb_unknown_one,
      'starting QB unknown for ' + unknownQb.join(' and '), 'Identify the starting QB', 'qb_identity:' + (unknownQb.length > 1 ? 'both' : (unknownQb[0] === c.team('home') ? 'home' : 'away')));
    if (unconfirmed.length) c.gate('QB_STATUS_UNCONFIRMED', cfg.caps.qb_status_unconfirmed,
      'no source has established whether ' + unconfirmed.map(function (x) { return x.name; }).join(' or ')
        + '’s starting QB can play — a known starter nobody has cleared is not VERY STRONG information',
      'Establish QB availability', 'availability:' + (unconfirmed.length > 1 ? 'both' : unconfirmed[0].side));
    if (contested.length) c.gate('QB_CONTESTED', cfg.caps.qb_contested,
      'the quarterback job is contested for ' + contested.join(' and '), 'Confirm the starting QB',
      'qb_identity:' + (contested[0] === c.team('home') ? 'home' : 'away'));
    /* a conflict the source hierarchy cannot settle: the same cap as a
       contested job — both are an unsettled answer to "who starts" */
    if (conflictedQb.length) c.gate('QB_CONFLICTED', cfg.caps.qb_contested,
      'QB sources conflict and the evidence hierarchy cannot settle it for ' + conflictedQb.map(function (x) { return x.name; }).join(' and ')
        + (conflictedQb[0].text ? ' (' + trim(conflictedQb[0].text, 140) + ')' : ''),
      'Resolve the QB source conflict', 'qb_conflict:' + conflictedQb[0].side);
    return items;
  }
  /* the contract says whether a refusal is this team's or the provider's */
  function refusedWhy(row) {
    var d = String((row && row.detail) || ''), re = /(\w+) refuses for all (\d+) programmes/g, m, src = [], n = null;
    while ((m = re.exec(d))) { src.push(m[1]); n = m[2]; }
    return src.length ? ' — a provider-wide refusal, not this team’s: ' + src.join(' and ') + ' refuse' + (src.length === 1 ? 's' : '')
      + ' for all ' + n + ' programmes' : '';
  }
  function nonQb(c, side) {
    var name = c.team(side), row = c.row('availability', side);
    var pers = c.in.personnel ? c.in.personnel[side] : null;
    var cov = 0, covWhy = null;
    var st = row ? row.state : null;
    var evA = c.ev && c.ev.availability ? c.ev.availability[side] : null;
    var evI = c.ev && c.ev.impact ? c.ev.impact[side] : null;
    /* with an evidence package, whether the read is comprehensive or official
       is the evidence class for THIS fixture, not the personnel layer's grade
       (which could come from a report filed for another game) */
    var comprehensive = evA ? evA.coverage_class === 'COMPREHENSIVE_OFFICIAL' : !!(pers && pers.coverage && pers.coverage.comprehensive);
    var official = evA ? (evA.coverage_class === 'COMPREHENSIVE_OFFICIAL' || evA.coverage_class === 'OFFICIAL_THIS_GAME')
      : !!(pers && pers.coverage && pers.coverage.official);
    if (st === 'USABLE') { cov = comprehensive ? 1.5 : (official ? 1.25 : 1.0);
      if (!comprehensive) covWhy = 'no comprehensive report covers ' + name + ' for this game'; }
    else if (st === 'RESEARCH_ONLY') { cov = 1.0; covWhy = 'the official report for ' + name + ' is absence-only (not comprehensive)'; }
    else if (st === 'STALE') { cov = 0.5; covWhy = name + '’s availability read is past its freshness floor'; }
    else if (st === 'NOT_DUE_YET') { cov = 0.75; covWhy = name + '’s availability report is not due yet'; }
    else if (st === 'NOT_REQUIRED') { cov = 0.5; covWhy = 'no conference availability report is required for ' + name + ' in this fixture'; }
    else if (st === 'FETCH_FAILED') { cov = 0; covWhy = evA ? evA.coverage_reason : name + '’s availability sources refused' + refusedWhy(row); }
    else { cov = 0; covWhy = evA ? evA.coverage_reason : 'no availability read covers ' + name; }
    if (evA && (st === 'STALE' || st === 'NOT_DUE_YET' || st === 'NOT_REQUIRED')) covWhy = evA.coverage_reason;
    /* WITH AN EVIDENCE PACKAGE: no current read for this fixture means the
       impact of absences cannot be assessed, whatever the personnel layer
       graded from another game's report; and an absence whose player-quality
       impact is UNKNOWN costs certainty by how much the role matters
       (football/enrichment/impact: CRITICAL/MAJOR at the rate this item
       always charged an unrated starter, 0.5; the back of the starting group
       0.25; rotation and depth 0.1) — never zero */
    var noRead = evA && !(st === 'USABLE' || st === 'RESEARCH_ONLY' || st === 'STALE');
    var evCost = evI && num(evI.unknown_impact_cost) != null ? evI.unknown_impact_cost : null;
    var evUnk = evI ? (evI.unknown_impact || 0) : 0, evImp = evI ? (evI.unknown_impact_important || 0) : 0;
    var evText = evI && evUnk ? evUnk + ' absence' + (evUnk === 1 ? '' : 's') + ' with UNKNOWN impact (no measured player quality)'
      + (evImp ? ', ' + evImp + ' in a critical or major role' : '') : null;
    /* impact certainty: an absence the projection does not price (the
       personnel impact rating moves no line until its coefficient is
       trained) is uncertainty the number carries silently */
    var imp = 0, impWhy = null, pStatus = pers ? String(pers.status || '') : null;
    if (noRead) {
      imp = 0; impWhy = 'the impact of ' + name + '’s absences cannot be assessed: no current availability read for this game';
    } else if (pers && pStatus === 'ASSESSED' && num(pers.impact) != null) {
      var qU = 0;
      (pers.absences || []).forEach(function (a) {
        var pa = num(a.probability_of_absence), ia = num(a.impact_if_absent);
        if (pa != null && ia != null && pa > 0 && pa < 1) qU += ia * 4 * pa * (1 - pa) / 100;
      });
      var cost = Math.min(1.5, 1.5 * pers.impact / 50 + 0.75 * Math.min(1, qU) + (evCost || 0));
      imp = 1.5 - cost;
      var kl = (pers.key_losses || [])[0];
      if (cost > 0.05) impWhy = name + ' non-QB absences rate ' + pers.impact + '/100 team impact'
        + (kl ? ' (largest: ' + (kl.label ? kl.label + ' ' : '') + (kl.player_name || '') + ', ' + (kl.injury_status || '').toLowerCase() + ')' : '')
        + ' — measured, not priced into the spread' + (evText && evCost ? '; plus ' + evText : '');
    } else if (pers && pStatus === 'UNRATED_ABSENCES' && evCost != null) {
      imp = 1.5 - Math.min(1.5, evCost);
      impWhy = evText || ('the ' + name + ' absences on file could not be rated');
    } else if (pers && pStatus === 'UNRATED_ABSENCES') {
      var starters = 0, deep = 0;
      (pers.unrated || []).forEach(function (a) { if (num(a.depth_rank) != null && a.depth_rank <= 2) starters++; else deep++; });
      var u = Math.min(1.5, 0.5 * starters + 0.1 * deep);
      imp = 1.5 - u;
      impWhy = (starters + deep) + ' ' + name + ' absence' + (starters + deep === 1 ? '' : 's') + ' on file could not be rated'
        + (starters ? ' (' + starters + ' at starter depth)' : '') + ' — no measured player quality';
    } else if (pers && pStatus === 'NO_ABSENCES_ON_FILE' && evCost) {
      /* the personnel layer read no absences, the fixture's evidence names
         some whose impact nobody has measured: the evidence is the newer read */
      imp = 1.5 - Math.min(1.5, evCost); impWhy = evText;
    } else if (pers && pStatus === 'NO_ABSENCES_ON_FILE') {
      imp = comprehensive ? 1.5 : 0.75;
      if (!comprehensive) impWhy = 'no absences are on file for ' + name + ', but no comprehensive report says the roster is whole';
    } else if (pers) {
      imp = 0; impWhy = 'the impact of ' + name + '’s absences cannot be assessed: no graded availability read';
    } else if (evI && evUnk && evCost != null) {
      imp = 1.5 - Math.min(1.5, evCost); impWhy = evText;
    } else if (evA && comprehensive && evI && !evI.absences) {
      imp = 1.5;
    } else {
      imp = st === 'USABLE' ? 0.75 : 0;
      impWhy = 'no personnel impact assessment was supplied for ' + name;
    }
    var e = cov + imp;
    var why = [covWhy, impWhy].filter(Boolean).join('; ');
    var act = null, key = null;
    if (st === 'FETCH_FAILED' || st === 'UNAVAILABLE' || !st) { act = 'Restore an injury/availability source for ' + name; key = 'availability:' + side; }
    else if (st === 'NOT_DUE_YET') { act = 'Re-read availability inside the filing window (' + name + ')'; key = 'availability:' + side; }
    else if (st === 'NOT_REQUIRED') { act = 'Register a school availability release for ' + name; key = 'availability:' + side; }
    else if (pStatus === 'UNRATED_ABSENCES' || (evCost && cov >= 1.5 - 1e-9)) { act = 'Rate the absent ' + name + ' players (player-quality attribution)'; key = 'attribution:' + side; }
    else if (e < 3 - 1e-9) { act = 'Refresh ' + name + ' injury availability'; key = 'availability:' + side; }
    return item('non_qb_' + side, name + ' non-QB availability', 3, e, { reason: e < 3 - 1e-9 ? why : null,
      action: e < 3 - 1e-9 ? act : null, action_key: e < 3 - 1e-9 ? key : null,
      missing: (st === 'FETCH_FAILED' || st === 'UNAVAILABLE' || !st) ? 'availability:' + side : null });
  }
  function rosterProduction(c, side, epa) {
    var name = c.team(side), rr = c.row('roster', side), tr = c.row('roster_talent', side);
    var qr = c.row('qb_efficiency_history', side);
    var gates = ((c.in.team_quality || {})[side] || {}).gates || [];
    var e = 0, bits = [];
    if (rr && rr.state === 'USABLE') e += 0.25;
    else if (rr && rr.state === 'STALE') { e += 0.1; bits.push('roster sync is stale'); }
    else bits.push('no roster for ' + name);
    var tc = c.in.roster_talent && c.in.roster_talent[side] ? num(c.in.roster_talent[side].confidence) : null;
    if (tc == null && tr && tr.detail) { var mm = /at confidence ([0-9.]+)/.exec(tr.detail); if (mm) tc = +mm[1]; }
    if (tr && tr.state === 'USABLE') {
      var f = tc == null ? 0.75 : clamp(tc / 0.5, 0, 1);
      e += 0.5 * f;
      if (f < 1) bits.push('player production attributed at confidence ' + r2(tc));
    } else bits.push('no player production layer for ' + name);
    if (qr && (qr.state === 'RESEARCH_ONLY' || qr.state === 'USABLE')) e += 0.25;
    else if (qr && qr.state === 'STALE') { e += 0.1; bits.push('QB efficiency history is stale'); }
    else if (qr && qr.state !== 'NOT_APPLICABLE') bits.push('no measured QB efficiency history');
    else if (!qr) bits.push('no QB efficiency history');
    if (gates.indexOf('EXTREME_TRANSFER_TURNOVER') >= 0) { e -= 0.25; bits.push('extreme transfer turnover (most of last season’s production is gone)'); }
    var fam = (tr && tr.state === 'USABLE') ? (gates.indexOf('EXTREME_TRANSFER_TURNOVER') >= 0 ? 'transfer_turnover' : 'attribution') : 'attribution';
    return item('roster_' + side, name + ' roster & production', 1, e, {
      reason: bits.length ? bits.join('; ') : null, family: fam,
      action: (tr && tr.state === 'USABLE') ? null : 'Extend player production attribution to ' + name,
      action_key: (tr && tr.state === 'USABLE') ? null : 'attribution:' + side });
  }

  /* ============================================ C. PROJECTION STABILITY (20) */
  function stabilityItems(c, stab) {
    var cfg = c.cfg, S = cfg.stability;
    if (!stab || !stab.measured) {
      c.gate('STABILITY_UNMEASURED', cfg.caps.stability_unmeasured,
        'projection stability was not measured' + (stab && stab.reason ? ' (' + stab.reason + ')' : ''), null, null);
      return [item('dispersion', 'spread dispersion under perturbation', S.sd_points, 0, {
        reason: 'not measured' + (stab && stab.reason ? ': ' + stab.reason : ''), missing: 'projection_stability' }),
        item('favorite_flips', 'favorite flips under perturbation', S.flip_points, 0, { reason: 'not measured' })];
    }
    var lg = stab.largest ? ' (largest source: ' + stab.largest.label + ', ±' + stab.largest.sigma + ' pts)' : '';
    var items = [
      item('dispersion', 'spread dispersion under perturbation', S.sd_points, stab.points.dispersion, { family: 'stability',
        reason: stab.points.dispersion < S.sd_points - 1e-9 ? 'the projected spread moves ±' + stab.projection_stability_sd
          + ' pts (1 SD) across ' + stab.n_scenarios + ' perturbation scenarios' + lg : null }),
      item('favorite_flips', 'favorite flips under perturbation', S.flip_points, stab.points.flips, { family: 'favorite_flips',
        reason: stab.favorite_flip_rate > 0 ? 'the projection flips favorite in ' + Math.round(stab.favorite_flip_rate * 100)
          + '% of sensitivity runs' : null })
    ];
    if (stab.tier === 'UNSTABLE') {
      var very = stab.favorite_flip_rate >= S.very_unstable_flip || stab.projection_stability_sd >= S.very_unstable_sd;
      c.gate(very ? 'VERY_UNSTABLE' : 'UNSTABLE', very ? cfg.caps.very_unstable : cfg.caps.unstable,
        'the projection is ' + (very ? 'extremely ' : '') + 'unstable: ±' + stab.projection_stability_sd + ' pts, favorite flips in '
          + Math.round(stab.favorite_flip_rate * 100) + '% of runs', null, null);
    }
    return items;
  }

  /* ================================================== D. FRESHNESS (15) */
  function band(age, cuts, max) {
    if (age == null) return 0;
    for (var i = 0; i < cuts.length; i++) if (age <= cuts[i]) return max * (cuts.length - i) / cuts.length;
    return 0;
  }
  function freshness(c) {
    var items = [], F = c.cfg.freshness, cfg = c.cfg, p = c.p, g = c.game;
    var future = [];
    function whenOf(r) { return r ? (r.observed_at || r.as_of || null) : null; }
    function checkFuture(label, t) { var a = c.age(t); if (a != null && a < -0.05) future.push(label); return a; }
    /* the rating state and the team statistics under it */
    var ms0 = c.in.model_state || {};
    var built = ms0.built_at || (p && p.prediction_timestamp) || null;
    var ma = checkFuture('model state', built);
    var mE = ma == null ? 0 : (ma < 0 ? 0 : band(ma, F.model_state, 3));
    var missedGames = (ms0.unabsorbed || []).filter(Boolean);
    if (missedGames.length) mE = 0;
    items.push(item('model_state', 'rating state / team statistics', 3, mE, {
      reason: missedGames.length ? 'the rating state predates ' + missedGames.join(' and ') + '’s most recent game'
        : (mE < 3 ? 'the rating state was built ' + hrs(ma) + ' ago' : null),
      action: mE < 3 ? 'Rebuild the rating state' : null, action_key: mE < 3 ? 'rebuild_state' : null }));
    if (missedGames.length || (ma != null && ma > F.model_state[F.model_state.length - 1]))
      c.gate('STALE_CORE', cfg.caps.stale_core, 'core team statistics are stale: ' + (missedGames.length
        ? 'the rating state has not absorbed ' + missedGames.join(' and ') + '’s latest game' : 'the rating state is ' + hrs(ma) + ' old'),
        'Rebuild the rating state', 'rebuild_state');
    /* the player production layer */
    var tr = [c.row('roster_talent', 'home'), c.row('roster_talent', 'away')].filter(function (r) { return r && r.state === 'USABLE'; });
    if (tr.length) {
      var ta = checkFuture('player layer', whenOf(tr[0]));
      var tE = band(ta, F.player_layer, 2);
      items.push(item('player_layer', 'player production layer', 2, tE, {
        reason: tE < 2 ? 'the player production layer was built ' + hrs(ta) + ' ago' : null,
        action: tE < 2 ? 'Rebuild the player layer' : null, action_key: tE < 2 ? 'rebuild_players' : null }));
    } else items.push(item('player_layer', 'player production layer', 2, 0, { na: true }));
    /* rosters */
    var rr = [c.row('roster', 'home'), c.row('roster', 'away')].filter(function (r) { return r && (r.state === 'USABLE' || r.state === 'STALE'); });
    if (rr.length) {
      var ra = checkFuture('roster', whenOf(rr[0]));
      var rE = band(ra, F.roster, 2);
      items.push(item('roster_age', 'roster sync', 2, rE, {
        reason: rE < 2 ? 'rosters were synced ' + hrs(ra) + ' ago' : null,
        action: rE < 2 ? 'Re-sync rosters' : null, action_key: rE < 2 ? 'roster_sync' : null }));
      if (ra != null && ra > F.roster[F.roster.length - 1]) c.gate('STALE_ROSTER', cfg.caps.stale_roster,
        'rosters are ' + hrs(ra) + ' old', 'Re-sync rosters', 'roster_sync');
    } else items.push(item('roster_age', 'roster sync', 2, 0, { na: true }));
    /* availability, each side on its own clock. A report not due yet, or not
       required, is as fresh as the world allows: its gap is scored under
       roster/availability, not charged twice here */
    ['home', 'away'].forEach(function (side) {
      var r = c.row('availability', side), name = c.team(side);
      if (r && (r.state === 'NOT_DUE_YET' || r.state === 'NOT_REQUIRED')) {
        items.push(item('availability_age_' + side, name + ' availability read', 1.5, 1.5)); return;
      }
      /* no read at all is charged once, under roster/availability */
      if (!r || r.state === 'FETCH_FAILED' || r.state === 'UNAVAILABLE') {
        items.push(item('availability_age_' + side, name + ' availability read', 1.5, 0, { na: true })); return;
      }
      var a = checkFuture(name + ' availability', whenOf(r));
      var e = r.state === 'STALE' ? 0 : band(a, F.availability, 1.5);
      items.push(item('availability_age_' + side, name + ' availability read', 1.5, e, {
        reason: e < 1.5 ? name + '’s availability was read ' + hrs(a) + ' ago' : null,
        action: e < 1.5 ? 'Refresh ' + name + ' injury availability' : null, action_key: e < 1.5 ? 'availability:' + side : null }));
    });
    /* quarterback status: re-read recently, about a recent game */
    ['home', 'away'].forEach(function (side) {
      var r = c.row('qb_starter', side), name = c.team(side);
      var st = (c.in.starters || {})[side] || null;
      if ((!r || r.state === 'UNAVAILABLE' || r.state === 'NOT_APPLICABLE') && !st) { items.push(item('qb_status_age_' + side, name + ' QB status age', 1, 0, { na: true })); return; }
      var ret = (st && st.retrieved_at) || (r && r.as_of) || null, obs = (st && st.published_at) || (r && r.observed_at) || null;
      var a1 = checkFuture(name + ' starter record', ret), a2 = checkFuture(name + ' starter evidence', obs);
      var e = (a1 != null && a1 >= 0 && a1 <= F.qb_retrieved ? 0.5 : 0) + (a2 != null && a2 >= 0 && a2 <= F.qb_observed ? 0.5 : 0);
      items.push(item('qb_status_age_' + side, name + ' QB status age', 1, e, {
        reason: e < 1 ? name + '’s starter record was re-read ' + hrs(a1) + ' ago and describes evidence from ' + hrs(a2) + ' ago' : null,
        action: e < 1 ? 'Re-read ' + name + '’s starter evidence' : null, action_key: e < 1 ? 'starters:' + side : null }));
    });
    /* weather: only outdoors and inside the forecast horizon */
    var w = c.row('weather', null), ko = ms(g.kickoff || g.start_date);
    var toKick = (ko != null && c.now != null) ? (ko - c.now) / 3600e3 : null;
    if (w && w.state === 'NOT_APPLICABLE') items.push(item('weather_age', 'forecast age', 1, 0, { na: true }));
    else if (toKick != null && toKick > F.weather_horizon) items.push(item('weather_age', 'forecast age', 1, 0, { na: true }));
    else if (w && (w.state === 'RESEARCH_ONLY' || w.state === 'USABLE' || w.state === 'STALE')) {
      var wa = checkFuture('forecast', w.observed_at || w.as_of);
      var we = w.state === 'STALE' ? 0 : band(wa, F.weather, 1);
      items.push(item('weather_age', 'forecast age', 1, we, { reason: we < 1 ? 'the forecast was observed ' + hrs(wa) + ' ago' : null,
        action: we < 1 ? 'Refresh the forecast' : null, action_key: we < 1 ? 'weather' : null }));
    } else items.push(item('weather_age', 'forecast age', 1, 0, { na: true }));
    /* the market quote, when this artifact joins one at all */
    var mk = c.in.market || null;
    if (!mk || mk.joined !== true) items.push(item('market_age', 'market quote age', 2, 0, { na: true }));
    else if (num(mk.spread_line) == null) items.push(item('market_age', 'market quote age', 2, 0, {
      reason: 'no market quote is joined to this game', action: 'Capture a market quote', action_key: 'market_quote', missing: 'market_quote' }));
    else {
      var qa = checkFuture('market quote', mk.as_of);
      var qe = mk.stale ? 0 : band(qa, F.market, 2);
      items.push(item('market_age', 'market quote age', 2, qe, {
        reason: qe < 2 ? (mk.stale ? 'the market quote is past its freshness limit' : 'the market quote was captured ' + hrs(qa) + ' ago') : null,
        action: qe < 2 ? 'Refresh the market quote' : null, action_key: qe < 2 ? 'market_quote' : null }));
    }
    if (future.length) c.gate('FUTURE_DATA', cfg.caps.future_data, 'input(s) stamped after the judging time: '
      + future.join(', ') + ' — nothing observed later than now may inform a pregame score', null, null);
    return items;
  }

  /* ============================================ E. SOURCE INTEGRITY (15) */
  function integrity(c) {
    var items = [], cfg = c.cfg, g = c.game, p = c.p;
    var starters = c.in.starters || {}, epa = c.in.qb_epa || {};
    var conflictSides = [];
    ['home', 'away'].forEach(function (side) {
      var name = c.team(side), st = starters[side] || null, pk = epa[side] || null, row = c.row('qb_starter', side);
      var q = c.ev && c.ev.quarterback ? c.ev.quarterback[side] : null;
      /* WITH THE RESOLVER: agreement is the share of the current evidence's
         weight (by tier; EdgeDesk's own quality ranking at half an observed
         start) that names the resolved starter. A disagreement the hierarchy
         settled costs only the weight that dissented; one it could not settle
         costs at least what a conflict always cost here */
      if (q) {
        if (!q.sources_n) { items.push(item('qb_sources_' + side, name + ' QB source agreement', 2, 0, { na: true })); return; }
        var idc = !!(pk && pk.identity && (pk.identity.contested === true || pk.identity.kind === 'UNRESOLVED'));
        var open = q.confirmation_level === 'CONFLICTED';
        var qe = 2 * (num(q.agreement) == null ? 1 : q.agreement);
        if (open) qe = Math.min(qe, 0.75);
        var qb = [];
        if (q.conflict) qb.push((q.conflict_resolved ? 'resolved by the source hierarchy: ' : 'UNRESOLVED: ') + trim(q.resolution_text || 'sources disagree', 170));
        if (idc) { qe -= 0.75; qb.push('the efficiency history could not resolve the same athlete'); }
        if (open && idc) conflictSides.push(name);
        items.push(item('qb_sources_' + side, name + ' QB source agreement', 2, qe, { reason: qb.length ? qb.join('; ') : null,
          action: qe < 2 - 1e-9 ? 'Resolve ' + name + '’s starter conflict' : null, action_key: qe < 2 - 1e-9 ? 'qb_conflict:' + side : null }));
        return;
      }
      if (!st && !row) { items.push(item('qb_sources_' + side, name + ' QB source agreement', 2, 0, { na: true })); return; }
      var nConf = st ? (Array.isArray(st.conflicts) ? st.conflicts.length : (num(st.conflicts) || 0)) : 0;
      var conflicting = nConf > 0 || (row && row.state === 'CONFLICTING');
      var idContested = !!(pk && pk.identity && (pk.identity.contested === true || pk.identity.kind === 'UNRESOLVED'));
      var e = 2, bits = [];
      if (conflicting) { e -= 1.25; bits.push('sources disagree about ' + name + '’s starter' + (st && st.player_name ? ' (' + st.player_name + ' named by one)' : '')); }
      if (idContested) { e -= 0.75; bits.push('the efficiency history could not resolve the same athlete'); }
      if (conflicting && idContested) conflictSides.push(name);
      items.push(item('qb_sources_' + side, name + ' QB source agreement', 2, e, { reason: bits.length ? bits.join('; ') : null,
        action: e < 2 ? 'Resolve ' + name + '’s starter conflict' : null, action_key: e < 2 ? 'qb_conflict:' + side : null }));
    });
    /* player identities behind every absence */
    var inj = c.in.injuries || {}, tot = 0, res = 0;
    ['home', 'away'].forEach(function (side) {
      (inj[side] || []).forEach(function (r) { if (!r) return; tot++; if (r.athlete_id) res++; });
    });
    if (!tot) items.push(item('player_identity', 'absent players resolved to athletes', 2, 0, { na: true }));
    else items.push(item('player_identity', 'absent players resolved to athletes', 2, 2 * res / tot, {
      reason: res < tot ? (tot - res) + ' of ' + tot + ' reported absences did not resolve to a unique athlete on the roster' : null,
      action: res < tot ? 'Resolve unmatched injury-report names' : null, action_key: res < tot ? 'player_identity' : null }));
    /* team identity */
    var hid = normKey(g.home_team_id || g.home_key || g.home || g.home_team), aid = normKey(g.away_team_id || g.away_key || g.away || g.away_team);
    var tE = 3, tBits = [];
    if (!hid || !aid) { tE = 0; tBits.push('a team does not resolve to a canonical identity'); }
    else if (hid === aid) { tE = 0; tBits.push('home and away resolve to the same identity (' + hid + ')'); }
    if (p && p.game && (g.home || g.home_team) && normKey(p.game.home) !== normKey(g.home || g.home_team)) { tE = 0; tBits.push('the projection is for ' + p.game.home + ', not ' + (g.home || g.home_team)); }
    if (p && p.game && (g.away || g.away_team) && normKey(p.game.away) !== normKey(g.away || g.away_team)) { tE = 0; tBits.push('the projection is for ' + p.game.away + ', not ' + (g.away || g.away_team)); }
    if (tE > 0 && (g.home_conference_id === undefined && g.away_conference_id === undefined) === false
        && (!g.home_conference_id || !g.away_conference_id)) { tE -= 1; tBits.push('a conference does not resolve'); }
    items.push(item('team_identity', 'team identity', 3, tE, { reason: tBits.length ? tBits.join('; ') : null }));
    if (tE === 0) c.gate('IDENTITY_CONFLICT', cfg.caps.identity_conflict, 'conflicting team identity: ' + tBits.join('; '),
      'Resolve the team mapping', 'team_identity');
    /* venue mapping: the stadium on the schedule vs the home venue table */
    var vr = c.row('venue_geography', 'home');
    if (!vr || vr.state !== 'USABLE') items.push(item('venue_mapping', 'venue mapping', 2, 0, {
      reason: 'the home venue does not resolve in the venue table', action: 'Resolve venue coordinates', action_key: 'venue' }));
    else {
      var vE = 2, vWhy = null;
      var sched = normKey(g.venue), table = normKey(vr.detail);
      if (!g.neutral_site && sched && table && sched !== table && sched.indexOf(table) < 0 && table.indexOf(sched) < 0) {
        vE = 1; vWhy = 'the schedule lists ' + g.venue + ' but ' + c.team('home') + '’s venue table says ' + vr.detail + ' (an unflagged neutral site?)';
      }
      items.push(item('venue_mapping', 'venue mapping', 2, vE, { reason: vWhy, action: vE < 2 ? 'Confirm the site of this game' : null,
        action_key: vE < 2 ? 'venue' : null }));
    }
    /* schedule mapping */
    var sOk = !!(g.game_id != null && ms(g.kickoff || g.start_date) != null);
    items.push(item('schedule_mapping', 'schedule mapping', 1, sOk ? 1 : 0, { reason: sOk ? null : 'the game has no id or no parseable kickoff' }));
    /* market mapping and sources, only when joined */
    var mk = c.in.market || null;
    if (!mk || mk.joined !== true || num(mk.spread_line) == null) {
      items.push(item('market_mapping', 'market-event mapping', 1.5, 0, { na: true }));
      items.push(item('market_sources', 'independent market sources', 0.5, 0, { na: true }));
    } else {
      items.push(item('market_mapping', 'market-event mapping', 1.5, mk.spread_fault ? 0 : 1.5, {
        reason: mk.spread_fault ? 'the market line only agreed with the model in the opposite spread convention and was dropped' : null,
        action: mk.spread_fault ? 'Re-map the market event' : null, action_key: mk.spread_fault ? 'market_map' : null }));
      var nb = num(mk.n_books);
      var bE = nb == null ? 0.25 : (nb >= 3 ? 0.5 : (nb === 2 ? 0.4 : (nb === 1 ? 0.2 : 0)));
      items.push(item('market_sources', 'independent market sources', 0.5, bE, {
        reason: bE < 0.5 ? (nb == null ? 'the number of books behind the quote is unknown' : 'only ' + nb + ' market source' + (nb === 1 ? '' : 's')) : null,
        action: bE < 0.5 ? 'Add another market source' : null, action_key: bE < 0.5 ? 'market_sources' : null }));
    }
    /* contradictory contract states */
    var conflicts = [];
    Object.keys(c.rows).forEach(function (k) { if (c.rows[k].state === 'CONFLICTING') conflicts.push(k); });
    items.push(item('contract_conflicts', 'no contradictory inputs', 1, conflicts.length ? 0 : 1, {
      reason: conflicts.length ? 'conflicting sources on ' + conflicts.join(', ') : null,
      action: conflicts.length ? 'Resolve conflicting sources' : null, action_key: conflicts.length ? 'contract_conflicts' : null }));
    var rosterConflict = conflicts.filter(function (k) { return /^(roster|availability)/.test(k); });
    if (rosterConflict.length || conflictSides.length) c.gate('ROSTER_CONFLICT', cfg.caps.roster_conflict,
      'unresolved roster conflict: ' + (rosterConflict.length ? rosterConflict.join(', ') : 'starter sources and the athlete identity disagree for ' + conflictSides.join(' and ')),
      'Resolve the roster conflict', conflictSides.length ? 'qb_conflict:' + (conflictSides[0] === c.team('home') ? 'home' : 'away') : 'contract_conflicts');
    return items;
  }

  /* ============================================== F. ENVIRONMENT (10) */
  function validCoords(v) { return !!(v && num(v.lat) != null && num(v.lon) != null && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180 && !(v.lat === 0 && v.lon === 0)); }
  function environment(c) {
    var items = [], g = c.game, F = c.cfg.freshness;
    var vr = c.row('venue_geography', 'home'), ar = c.row('venue_geography', 'away');
    var venues = c.in.venues || null;
    var vid = !!(g.venue || (vr && vr.state === 'USABLE') || g.venue_id != null);
    items.push(item('venue', 'venue identified', 2, vid ? 2 : 0, { reason: vid ? null : 'the venue of this game is not identified',
      action: vid ? null : 'Identify the venue', action_key: vid ? null : 'venue', missing: vid ? null : 'venue' }));
    var hc = venues ? validCoords(venues.home) : (vr && vr.state === 'USABLE');
    items.push(item('venue_coords', 'venue coordinates', 2, hc ? 2 : 0, {
      reason: hc ? null : 'no coordinates for ' + c.team('home') + '’s venue' + (g.venue ? ' (' + g.venue + ')' : ''),
      action: hc ? null : 'Resolve venue coordinates', action_key: hc ? null : 'venue', missing: hc ? null : 'venue_coordinates' }));
    var siteKnown = g.neutral_site === true || g.neutral_site === false;
    items.push(item('site', 'home/away/neutral status', 1, siteKnown ? 1 : 0, { reason: siteKnown ? null : 'the schedule does not say whether the site is neutral' }));
    if (g.neutral_site === true || (ar && ar.state === 'NOT_APPLICABLE')) items.push(item('travel', 'travel inputs', 1.5, 0, { na: true }));
    else {
      var ac = venues ? validCoords(venues.away) : (ar && ar.state === 'USABLE');
      items.push(item('travel', 'travel inputs', 1.5, ac ? 1.5 : 0, {
        reason: ac ? null : 'no coordinates for ' + c.team('away') + '’s home venue, so travel cannot be measured',
        action: ac ? null : 'Resolve ' + c.team('away') + '’s venue coordinates', action_key: ac ? null : 'venue_away',
        missing: ac ? null : 'travel_coordinates' }));
    }
    var w = c.row('weather', null), ko = ms(g.kickoff || g.start_date);
    var toKick = (ko != null && c.now != null) ? (ko - c.now) / 3600e3 : null;
    if (w && w.state === 'NOT_APPLICABLE') items.push(item('weather', 'weather where relevant', 1.5, 0, { na: true }));
    else if (toKick != null && toKick > F.weather_horizon) items.push(item('weather', 'weather where relevant', 1.5, 0, { na: true }));
    else if (w && (w.state === 'RESEARCH_ONLY' || w.state === 'USABLE')) items.push(item('weather', 'weather where relevant', 1.5, 1.5));
    else if (w && w.state === 'STALE') items.push(item('weather', 'weather where relevant', 1.5, 0.75, { reason: 'the forecast on file is stale',
      action: 'Refresh the forecast', action_key: 'weather' }));
    else items.push(item('weather', 'weather where relevant', 1.5, 0, {
      reason: 'no forecast for an outdoor game' + (w && w.detail ? ' (' + trim(w.detail, 90) + ')' : ''),
      action: 'Fetch the venue forecast', action_key: 'weather', missing: 'weather' }));
    var rh = c.row('schedule_context', 'home'), ra = c.row('schedule_context', 'away');
    var restNa = (rh && rh.state === 'NOT_APPLICABLE') && (ra && ra.state === 'NOT_APPLICABLE');
    if (restNa) items.push(item('rest', 'rest', 1, 0, { na: true }));
    else {
      var n = 0, d = 0;
      [rh, ra].forEach(function (r) { if (r && r.state === 'NOT_APPLICABLE') return; d++; if (r && r.state === 'USABLE') n++; });
      items.push(item('rest', 'rest', 1, d ? n / d : 0, { reason: n < d ? 'rest is not measured for one side' : null }));
    }
    var cls = !!(g.matchup_type && (g.home_conference_id || g.home_conference) && (g.away_conference_id || g.away_conference));
    items.push(item('classification', 'matchup & conference classification', 1, cls ? 1 : 0, {
      reason: cls ? null : 'the matchup or a conference is not classified' }));
    return items;
  }

  /* ============================================== MODEL SELF-CHECK */
  function selfCheck(c) {
    var p = c.p, faults = [];
    if (!p) { faults.push('no projection was supplied'); return faults; }
    if (p.status !== 'PREDICTED') { faults.push('the engine did not publish a projection (' + p.status + (p.reason ? ': ' + trim(p.reason, 100) : '') + ')'); return faults; }
    var m = p.model || {}, fs = num(m.fair_spread), ph = num(m.home_win_prob);
    if (fs == null || Math.abs(fs) > 70) faults.push('the fair spread is not a finite number inside ±70');
    if (ph != null && !(ph > 0 && ph < 1)) faults.push('the win probability is outside (0, 1)');
    if (fs != null && ph != null && Math.abs(fs) >= 0.5 && (ph - 0.5) * fs < 0) faults.push('the win probability favours the other team from the fair spread');
    var p10 = num(m.p10_margin), p50 = num(m.median_margin), p90 = num(m.p90_margin);
    if (p10 != null && p90 != null && p10 > p90) faults.push('the outcome range is inverted (p10 > p90)');
    if (p50 != null && p10 != null && p90 != null && (p50 < p10 - 1e-9 || p50 > p90 + 1e-9)) faults.push('the median lies outside its own range');
    var cs = p.contributions || [];
    if (cs.length && fs != null) {
      var sum = 0; cs.forEach(function (t) { if (t && t.available && num(t.points) != null) sum += t.points; });
      if (Math.abs(sum - fs) > 0.01) faults.push('the engine’s additive terms (' + r2(sum) + ') do not sum to its fair spread (' + r2(fs) + ')');
    }
    return faults;
  }

  /* ========================================================= THE SCORE */
  function gradeOf(score, cfg) {
    for (var i = 0; i < cfg.grades.length; i++) if (score >= cfg.grades[i].min) return cfg.grades[i];
    return cfg.grades[cfg.grades.length - 1];
  }
  R.grade = function (score, over) { var g = gradeOf(score, R.config(over)); return { key: g.key, label: g.label }; };
  R.legacyTier = function (score, over) {
    var cfg = R.config(over);
    if (num(score) == null) return null;
    return score >= cfg.legacy.strong ? 'STRONG' : (score >= cfg.legacy.adequate ? 'ADEQUATE' : 'LOW');
  };
  function componentOf(key, items, weight) {
    var mx = 0, ea = 0;
    items.forEach(function (it) { if (it.state !== 'NOT_APPLICABLE') { mx += it.max; ea += it.earned; } });
    var score = mx > 0 ? weight * ea / mx : weight;
    return { key: key, score: r1(score), max: weight, earned_raw: r2(ea), applicable_max: r2(mx), items: items };
  }
  function finish(components, gates, cfg) {
    var raw = 0;
    Object.keys(components).forEach(function (k) { raw += components[k].score; });
    raw = clamp(raw, 0, 100);
    var cap = 100, binding = [];
    gates.forEach(function (g) { if (g.cap < cap) cap = g.cap; });
    gates.forEach(function (g) { if (g.cap === cap && raw > cap) binding.push(g.id); });
    var score = Math.round(Math.min(raw, cap));
    return { raw: r1(raw), score: score, cap: cap < 100 ? cap : null, capped_by: binding };
  }
  var LABEL = { team_data: 'Team data', roster_availability: 'Roster/status', projection_stability: 'Stability',
    freshness: 'Freshness', source_integrity: 'Source integrity', environment: 'Environment' };
  R.COMPONENT_LABEL = LABEL;
  R.COMPONENT_ORDER = ['team_data', 'roster_availability', 'projection_stability', 'freshness', 'source_integrity', 'environment'];

  /* input = {
       now          the judging time (ms or ISO). Required: freshness is
                    judged here, and nothing stamped later may inform it
       game         {game_id, home, away, kickoff, neutral_site, venue,
                     home_fbs, away_fbs, home_team_id, away_team_id,
                     home_conference_id, away_conference_id, matchup_type}
       projection   the engine's projectGame output, unmodified
       contract     the input contract rows (football/matchup/contract.js)
       starters     {home, away} starter records (football/starters/)
       qb_epa       {home, away} efficiency packets (identity.contested/kind)
       injuries     {home, away} the engine's injury lists (athlete ids)
       personnel    {home, away} personnel impact team blocks
                    (football/personnel/current.json games[id].home/away)
       team_quality {home, away} {gates: [...]} from football/rankings
       roster_talent {home, away} {confidence} player-layer confidence
       venues       {home, away} venue records with lat/lon (optional)
       market       {joined, spread_line, as_of, stale, spread_fault, n_books}
                    — joined:false (or absent) when this caller joins no
                    market at all: the market items then do not apply
       model_state  {built_at, unabsorbed: [team names whose latest game the
                    state has not absorbed]}
       blend        {home, away} engine strength.blendedRating per side
       params       the engine's parameters (EDCfbP4Params), for stability
       stability    a precomputed R.stability() result (else computed here)
     } */
  R.score = function (input, over) {
    input = input || {};
    var cfg = R.config(over);
    var c = new Ctx(input, cfg);
    var faults = selfCheck(c);
    var fcsEv = c.ev && c.ev.team_data ? { home: c.ev.team_data.home && c.ev.team_data.home.fcs, away: c.ev.team_data.away && c.ev.team_data.away.fcs } : null;
    var stab = input.stability || R.stability(c.p, { params: input.params, blend: input.blend,
      fbs: { home: !c.floorPriced('home'), away: !c.floorPriced('away') }, fcs: fcsEv }, over);
    var W = cfg.weights;
    var comps = {
      team_data: componentOf('team_data', teamData(c), W.team_data),
      roster_availability: componentOf('roster_availability', rosterAvailability(c), W.roster_availability),
      projection_stability: componentOf('projection_stability', stabilityItems(c, stab), W.projection_stability),
      freshness: componentOf('freshness', freshness(c), W.freshness),
      source_integrity: componentOf('source_integrity', integrity(c), W.source_integrity),
      environment: componentOf('environment', environment(c), W.environment)
    };
    if (faults.length) c.gate('DATA_FAULT', cfg.caps.data_fault, 'model self-check failed: ' + faults.join('; '), null, null);
    var fin = finish(comps, c.gates, cfg);
    var gr = gradeOf(fin.score, cfg);
    /* every point lost, largest first, with its reason */
    var penalties = [], missing = [];
    R.COMPONENT_ORDER.forEach(function (k) {
      var comp = comps[k], scale = comp.applicable_max > 0 ? comp.max / comp.applicable_max : 1;
      comp.items.forEach(function (it) {
        if (it.state === 'NOT_APPLICABLE') return;
        var lost = (it.max - it.earned) * scale;
        if (lost > 0.049) penalties.push({ component: k, item: it.id, label: it.label, points: r1(lost),
          reason: it.reason || (it.label + ' not earned'), action: it.action || null, action_key: it.action_key || null,
          family: it.family || null });
        if (it.missing) missing.push(it.missing);
      });
    });
    penalties.sort(function (a, b) { return (b.points - a.points) || (a.item < b.item ? -1 : (a.item > b.item ? 1 : 0)); });
    var gates = c.gates.map(function (g) { return { id: g.id, cap: g.cap, binding: fin.capped_by.indexOf(g.id) >= 0,
      reason: g.reason, action: g.action, action_key: g.action_key }; });
    var warnings = gates.map(function (g) { return g.id + ': ' + g.reason; });
    var main = fin.capped_by.length
      ? gates.filter(function (g) { return g.binding; })[0].reason
      : (penalties[0] ? penalties[0].reason : null);
    var out = {
      contract: R.version,
      score: fin.score,
      grade: gr.key, grade_label: gr.label,
      tier: R.legacyTier(fin.score, over),
      raw: fin.raw, cap: fin.cap, capped_by: fin.capped_by,
      gate_label: faults.length ? 'DATA FAULT' : (c.gates.some(function (g) { return g.id === 'THIN_DATA'; }) ? 'THIN DATA' : null),
      components: {},
      penalties: penalties, gates: gates, warnings: warnings, missing: missing,
      main_deduction: main,
      stability: stab && stab.measured ? {
        projection_stability_score: stab.projection_stability_score, projection_stability_sd: stab.projection_stability_sd,
        projection_p10: stab.projection_p10, projection_p50: stab.projection_p50, projection_p90: stab.projection_p90,
        favorite_flip_rate: stab.favorite_flip_rate, tier: stab.tier, tier_label: stab.tier_label,
        n_scenarios: stab.n_scenarios, method: stab.method, dimensions: stab.dimensions, largest: stab.largest,
        not_perturbed: stab.not_perturbed } : { measured: false, reason: stab ? stab.reason : null },
      not_scored: [
        { field: 'off_field', why: 'off-field reporting: no source is registered for any programme, it moves no point, and it carries 0.05 of the engine’s 4.083 information weight — published in the input contract, not scored here' },
        { field: 'recruiting_talent', why: 'research-only and redundant with the measured player production layer, which is scored' },
        { field: 'coaching_continuity', why: 'research-only (params.unavailable_by_design.coaching_continuity): it moves no point' }
      ],
      basis: 'Reliability is how much EdgeDesk trusts the completeness, freshness, consistency and stability of the information under this projection — not a probability that the projection is right, and not a betting signal.'
    };
    R.COMPONENT_ORDER.forEach(function (k) {
      var comp = comps[k];
      out.components[k] = { score: comp.score, max: comp.max, label: LABEL[k],
        items: comp.items.map(function (it) { return { id: it.id, label: it.label, earned: it.earned, max: it.max,
          state: it.state, reason: it.reason }; }) };
    });
    out.next_actions = fin.score < 90 ? nextActions(comps, c.gates, fin, cfg) : [];
    var rec = recoverability(comps, c.gates, fin, cfg);
    out.potential = rec.potential;
    out.recoverable_by_family = rec.by_family;
    out.evidence = c.ev ? { used: true, built_at: c.ev.built_at || null, artifact_generated_at: c.ev.artifact_generated_at || null,
      frozen: !!c.ev.frozen, window: c.ev.window ? c.ev.window.key : null } : { used: false };
    return out;
  };

  /* WHAT WOULD RAISE IT. Every recoverable deduction carries an action key;
     for each key the game is re-scored with those items earned in full and
     the gates that key lifts removed. The gain is an UPPER BOUND with every
     other input held where it is — stability, which a better input would
     also move, is not re-simulated — so it is published as "up to". */
  /* THE RE-SCORER every "what if" reads: the items each action key would
     earn in full, and the gates it lifts. Shared by next actions, potential
     reliability and the enrichment ROI planner, so none of them can disagree
     about what resolving an input is worth */
  function simulator(comps, gates, cfg) {
    var byKey = {};
    R.COMPONENT_ORDER.forEach(function (k) {
      comps[k].items.forEach(function (it) {
        if (!it.action_key || it.state === 'NOT_APPLICABLE' || it.earned >= it.max - 1e-9) return;
        var e = byKey[it.action_key] || (byKey[it.action_key] = { key: it.action_key, action: it.action, items: [], heaviest: -1 });
        if (it.max - it.earned > e.heaviest) { e.heaviest = it.max - it.earned; e.action = it.action || e.action; }
        e.items.push(k + '/' + it.id);
      });
    });
    /* a both-sides gate is lifted only when both sides are resolved */
    function expand(k) { return /:both$/.test(k) ? [k.replace(/:both$/, ':home'), k.replace(/:both$/, ':away')] : [k]; }
    gates.forEach(function (g) {
      if (!g.action_key) return;
      expand(g.action_key).forEach(function (k) { if (!byKey[k]) byKey[k] = { key: k, action: g.action, items: [], heaviest: -1 }; });
    });
    /* the score with these inputs resolved in full and the gates they lift
       removed; every other input held where it is */
    function simulate(keys) {
      var done = {};
      keys.forEach(function (k) { (byKey[k] ? byKey[k].items : []).forEach(function (x) { done[x] = 1; }); });
      var sim = {};
      R.COMPONENT_ORDER.forEach(function (k) {
        var its = comps[k].items.map(function (it) {
          if (!done[k + '/' + it.id]) return it;
          var cp = {}, f; for (f in it) cp[f] = it[f]; cp.earned = cp.max; return cp;
        });
        sim[k] = componentOf(k, its, comps[k].max);
      });
      var left = [];
      gates.forEach(function (g) {
        if (!g.action_key) { left.push(g); return; }
        var need = expand(g.action_key), got = need.filter(function (k) { return keys.indexOf(k) >= 0; }).length;
        if (got === need.length) return;
        /* one side of a both-sides unknown QB resolved: the one-side cap stays */
        if (got && g.id === 'QB_UNKNOWN_BOTH') { left.push({ id: 'QB_UNKNOWN', cap: cfg.caps.qb_unknown_one }); return; }
        left.push(g);
      });
      return finish(sim, left, cfg).score;
    }
    return { byKey: byKey, expand: expand, simulate: simulate };
  }

  /* POTENTIAL RELIABILITY: the score this game could approximately reach if
     every input with a recovery action were resolved, the gates they lift
     removed, stability held where it is. It is NOT a probability and NOT a
     forecast that the inputs will be resolved. Plus, per work family (the
     action key's prefix), what resolving that family alone recovers — the
     enrichment ROI planner sums these across the slate */
  function recoverability(comps, gates, fin, cfg) {
    var S = simulator(comps, gates, cfg);
    var keys = Object.keys(S.byKey).sort();
    var fam = {};
    keys.forEach(function (k) { var f = String(k).split(':')[0]; (fam[f] = fam[f] || []).push(k); });
    var byFam = {};
    Object.keys(fam).sort().forEach(function (f) { var g = S.simulate(fam[f]) - fin.score; if (g > 0) byFam[f] = g; });
    var pot = keys.length ? S.simulate(keys) : fin.score;
    return { potential: { score: pot, gain: pot - fin.score, unresolved_inputs: keys.length,
      basis: 'every input with a recovery action resolved in full and the gates it lifts removed, stability held where it is: the score this game could approximately reach — not a probability' },
      by_family: byFam };
  }

  function nextActions(comps, gates, fin, cfg) {
    var S0 = simulator(comps, gates, cfg), byKey = S0.byKey, expand = S0.expand, simulate = S0.simulate;
    var BASIS = 'upper bound: this input resolved in full, every other input held where it is; stability is not re-simulated';
    /* the actions that lift the cap now binding: an input behind that cap
       gains nothing on its own and is reported for after it */
    var binding = [];
    gates.forEach(function (g) {
      if (fin.capped_by.indexOf(g.id) < 0 || !g.action_key) return;
      expand(g.action_key).forEach(function (k) { if (binding.indexOf(k) < 0) binding.push(k); });
    });
    var bindingText = binding.map(function (k) { return byKey[k] && byKey[k].action; }).filter(function (t, i, a) { return t && a.indexOf(t) === i; }).join(' and ');
    var afterBinding = binding.length ? simulate(binding) : null;
    var out = [], later = [];
    Object.keys(byKey).sort().forEach(function (key) {
      var a = byKey[key];
      var gain = simulate([key]) - fin.score;
      if (gain >= 1) {
        out.push({ action: a.action, key: key, potential_gain: gain, potential_gain_text: 'up to +' + gain, basis: BASIS });
        return;
      }
      if (afterBinding == null || binding.indexOf(key) >= 0) return;
      var cond = simulate(binding.concat([key])) - afterBinding;
      if (cond >= 1) later.push({ action: a.action, key: key, potential_gain: cond, conditional: true, requires: binding.slice(),
        potential_gain_text: 'up to +' + cond + ' once ' + (bindingText ? bindingText.charAt(0).toLowerCase() + bindingText.slice(1) : 'the binding cap') + ' is done',
        basis: BASIS + '; conditional on the capping input being resolved first' });
    });
    function bySize(x, y) { return (y.potential_gain - x.potential_gain) || (x.key < y.key ? -1 : 1); }
    out.sort(bySize); later.sort(bySize);
    return out.concat(later).slice(0, cfg.next_actions_max);
  }

  /* ================================================== THE ADAPTER
     ONE assembly of the score's input from the facts a caller holds, so the
     published build (football/fbs/build_coverage.js) and the board
     (app.html) cannot build it two ways. Everything is optional; what is
     absent is scored as absent.

       o.game        the schedule row {game_id, home_team, away_team,
                     start_date, neutral_site, venue, venue_id, week}
       o.meta        {home:{key,is_fbs,conference_id}, away:{...}, matchup_type}
       o.projection  projectGame output
       o.contract    the input contract rows
       o.starters, o.qb_epa, o.injuries, o.venues, o.rosters   {home, away}
       o.personnel   one game's personnel entry ({home, away} team blocks,
                     full or R.compactPersonnel form)
       o.team_quality {home:{gates}, away:{gates}}
       o.market      the caller's market join, or null when it joins none
       o.built_at    when the rating state was built
       o.engine, o.state, o.params   for the per-team blend (stability)
       o.evidence    the game evidence package (lib/game_evidence.js
                     complete()), or null: availability, quarterback,
                     impact and FCS evidence then come from it */
  R.compactPersonnel = function (t) {
    if (!t) return null;
    return { status: t.status || null, impact: num(t.impact), confidence: num(t.confidence),
      coverage: t.coverage ? { grade: t.coverage.grade || null, official: !!t.coverage.official,
        comprehensive: !!t.coverage.comprehensive, as_of: t.coverage.as_of || null } : null,
      key_losses: (t.key_losses || []).slice(0, 2).map(function (k) { return { label: k.label || null,
        player_name: k.player_name || null, injury_status: k.injury_status || null, impact_if_absent: num(k.impact_if_absent) }; }),
      absences: (t.absences || []).map(function (a) { return { probability_of_absence: num(a.probability_of_absence),
        impact_if_absent: num(a.impact_if_absent) }; }),
      unrated: (t.unrated || []).map(function (a) { return { depth_rank: num(a.depth_rank) }; }),
      team_id: t.team_id || null };
  };
  R.teamQuality = function (t) {
    if (!t) return null;
    return { gates: (t.gates || []).map(function (g) { return g && (g.id || g); }).filter(Boolean),
      confidence: t.confidence && num(t.confidence.value) != null ? t.confidence.value : num(t.confidence) };
  };
  R.inputFor = function (o) {
    o = o || {};
    var g = o.game || {}, m = o.meta || {}, mh = m.home || {}, ma = m.away || {};
    var p = o.projection || null;
    var pers = o.personnel || null, pOut = null;
    if (pers && (pers.home || pers.away)) {
      pOut = { home: pers.home || null, away: pers.away || null };
      /* a personnel entry keyed to the same game id must be about the same
         two teams; swapped sides are re-sided, a stranger is refused */
      var hk = normKey(mh.key || g.home_team), ak = normKey(ma.key || g.away_team);
      var ph = pOut.home && normKey(pOut.home.team_id), pa = pOut.away && normKey(pOut.away.team_id);
      if (ph && pa && hk && ak) {
        if (ph === ak && pa === hk) pOut = { home: pOut.away, away: pOut.home };
        else if (ph !== hk || pa !== ak) pOut = null;
      }
    }
    var blend = null;
    var E = o.engine;
    if (E && E.strength && typeof E.strength.blendedRating === 'function' && o.state && p && p.status === 'PREDICTED') {
      var nk = E.normKey || normKey;
      try {
        blend = { home: E.strength.blendedRating(o.state, nk(g.home_team), mh.is_fbs !== false, g.week),
          away: E.strength.blendedRating(o.state, nk(g.away_team), ma.is_fbs !== false, g.week) };
      } catch (_) { blend = null; }
    }
    var rosters = o.rosters || {};
    function tc(side) { var r = rosters[side]; return r && num(r.overall_talent_confidence) != null ? { confidence: r.overall_talent_confidence } : null; }
    return {
      now: o.now,
      game: { game_id: g.game_id == null ? null : String(g.game_id), home: g.home_team, away: g.away_team,
        kickoff: g.start_date || g.kickoff || null, neutral_site: g.neutral_site === true ? true : (g.neutral_site === false ? false : !!g.neutral_site),
        venue: g.venue || null, venue_id: g.venue_id == null ? null : g.venue_id, week: g.week,
        home_fbs: mh.is_fbs === false ? false : (mh.is_fbs === true ? true : undefined),
        away_fbs: ma.is_fbs === false ? false : (ma.is_fbs === true ? true : undefined),
        home_team_id: mh.key || null, away_team_id: ma.key || null,
        home_conference_id: mh.conference_id || null, away_conference_id: ma.conference_id || null,
        home_conference: mh.conference || g.home_conference || null, away_conference: ma.conference || g.away_conference || null,
        matchup_type: m.matchup_type || null },
      projection: p,
      contract: o.contract || [],
      starters: o.starters || {},
      qb_epa: o.qb_epa || {},
      injuries: o.injuries || {},
      venues: o.venues || null,
      roster_talent: { home: tc('home'), away: tc('away') },
      personnel: pOut,
      team_quality: o.team_quality || {},
      market: o.market || { joined: false },
      model_state: { built_at: o.built_at || null, unabsorbed: o.unabsorbed || [] },
      blend: blend,
      params: o.params || null,
      /* the game evidence package (lib/game_evidence.js) the score is
         calculated from, when the caller has one */
      evidence: o.evidence || null
    };
  };

  /* ================================================== EXPLANATION
     The hover/click text: the score and grade, each component, and the main
     deduction or why it is low — always the specific reasons the engine
     measured, never "input data incomplete". */
  function fmtPts(x) { return (Math.round(x * 10) / 10).toString().replace(/\.0$/, ''); }
  R.explain = function (r) {
    if (!r || r.score == null) return ['RELIABILITY — not measured'];
    var L = ['RELIABILITY ' + r.score + ' — ' + r.grade_label + (r.gate_label ? ' · ' + r.gate_label : '')];
    R.COMPONENT_ORDER.forEach(function (k) {
      var c = r.components[k]; if (!c) return;
      L.push(c.label + ' ' + fmtPts(c.score) + '/' + c.max);
    });
    if (r.stability && r.stability.tier_label) L.push('Stability: ' + r.stability.tier_label + ' (±' + r.stability.projection_stability_sd
      + ' pts, favorite flips ' + Math.round(r.stability.favorite_flip_rate * 100) + '%)');
    var why = [];
    (r.gates || []).filter(function (g) { return g.binding; }).forEach(function (g) { why.push(g.reason + ' (capped at ' + g.cap + ')'); });
    (r.penalties || []).slice(0, r.score < 70 ? 5 : 2).forEach(function (p) { if (why.indexOf(p.reason) < 0) why.push(p.reason); });
    if (why.length) {
      if (r.score >= 70 && why.length) L.push('Main deduction: ' + why[0] + '.');
      else { L.push('Why ' + r.grade_label.toLowerCase() + ':'); why.forEach(function (w) { L.push('• ' + w); }); }
    }
    if ((r.next_actions || []).length) {
      L.push('Would raise it:');
      r.next_actions.slice(0, 3).forEach(function (a) { L.push('• ' + a.action + ' (' + a.potential_gain_text + ')'); });
    }
    if (r.potential && r.potential.score != null && r.potential.score > r.score) L.push('Potential reliability: ' + r.potential.score
      + ' if the unresolved evidence were resolved (not a probability).');
    L.push('Not a probability: reliability ' + r.score + ' does not mean a ' + r.score + '% chance the projection is right.');
    return L;
  };
  /* THE PUBLISHED FORM a slate row carries: every component and item with
     its reason, the gates, the largest deductions and what would raise it —
     everything the hover/click explanation reads — without the constant
     prose (basis, not_scored) that lives once on the artifact */
  R.published = function (r) {
    if (!r) return null;
    var comp = {}, na = [];
    R.COMPONENT_ORDER.forEach(function (k) {
      var c = r.components[k]; if (!c) return;
      comp[k] = { score: c.score, max: c.max, label: c.label };
      c.items.forEach(function (it) { if (it.state === 'NOT_APPLICABLE') na.push(k + '/' + it.id); });
    });
    var st = r.stability || {};
    return { contract: r.contract, score: r.score, grade: r.grade, grade_label: r.grade_label, tier: r.tier,
      raw: r.raw, cap: r.cap, capped_by: r.capped_by, gate_label: r.gate_label, main_deduction: r.main_deduction,
      components: comp,
      /* every point lost is here with its reason; an item earned in full is
         not repeated, and one that does not apply is named once */
      penalties: (r.penalties || []).map(function (p) { return { component: p.component, item: p.item,
        points: p.points, reason: p.reason, family: p.family || null }; }),
      not_applicable: na,
      gates: (r.gates || []).map(function (g) { return { id: g.id, cap: g.cap, binding: g.binding, reason: g.reason }; }),
      missing: r.missing,
      stability: st.tier ? { projection_stability_score: st.projection_stability_score, projection_stability_sd: st.projection_stability_sd,
        projection_p10: st.projection_p10, projection_p50: st.projection_p50, projection_p90: st.projection_p90,
        favorite_flip_rate: st.favorite_flip_rate, tier: st.tier, tier_label: st.tier_label, n_scenarios: st.n_scenarios,
        dimensions: (st.dimensions || []).map(function (d) { return { key: d.key, sigma: d.sigma }; }),
        largest: st.largest || null } : { measured: false, reason: st.reason || null },
      next_actions: (r.next_actions || []).map(function (a) { return { action: a.action, key: a.key,
        potential_gain: a.potential_gain, potential_gain_text: a.potential_gain_text }; }),
      potential: r.potential ? { score: r.potential.score, gain: r.potential.gain } : null,
      recoverable_by_family: r.recoverable_by_family || null,
      evidence_used: !!(r.evidence && r.evidence.used) };
  };
  /* the compact form an export, the dashboard list or the record persists */
  R.compact = function (r) {
    if (!r) return null;
    var comp = {};
    R.COMPONENT_ORDER.forEach(function (k) { if (r.components[k]) comp[k] = { score: r.components[k].score, max: r.components[k].max }; });
    return { contract: r.contract, score: r.score, grade: r.grade, grade_label: r.grade_label, tier: r.tier,
      raw: r.raw, capped_by: r.capped_by, gate_label: r.gate_label, components: comp,
      main_deduction: r.main_deduction,
      potential: r.potential ? r.potential.score : null,
      evidence_used: !!(r.evidence && r.evidence.used),
      stability: r.stability && r.stability.tier ? { sd: r.stability.projection_stability_sd, p10: r.stability.projection_p10,
        p50: r.stability.projection_p50, p90: r.stability.projection_p90, favorite_flip_rate: r.stability.favorite_flip_rate,
        tier: r.stability.tier } : null };
  };

  /* ================================================== THE DASHBOARD
     rows: [{game_id, home, away, home_conference, away_conference,
     matchup_type, reliability: <R.score result>}] */
  function pct(sorted, q) { var v = quantile(sorted, q); return v == null ? null : r1(v); }
  var BOTTLENECK_LABEL = {
    availability: 'Injury/availability information incomplete', qb_status: 'QB status unconfirmed (can he play)',
    rating_sample: 'In-season rating sample still thin', prior_missing: 'No prior-season rating',
    fcs_dominated: 'Rating sample dominated by FCS opponents', transfer_turnover: 'Extreme transfer turnover',
    favorite_flips: 'Projection flips favorite under perturbation',
    qb_identity: 'Starting QB not confirmed', attribution: 'Player production attribution incomplete',
    fcs_rating: 'Unrated (FCS) opponent', matchup_profile: 'Matchup profile missing', market_quote: 'Market quote missing or stale',
    market_sources: 'Market source thin', weather: 'Forecast unavailable', venue: 'Venue/coordinates unresolved',
    venue_away: 'Travel coordinates unresolved', qb_conflict: 'QB sources disagree', starters: 'Starter evidence stale',
    roster_sync: 'Roster sync stale', rebuild_state: 'Rating state stale', rebuild_players: 'Player layer stale',
    player_identity: 'Injury names unresolved', contract_conflicts: 'Conflicting sources', team_identity: 'Team identity conflict',
    market_map: 'Market event mis-mapped', stability: 'Projection dispersion under perturbation', rate: 'Team not rated',
    schedule_context: 'Schedule context missing'
  };
  R.BOTTLENECK_LABEL = BOTTLENECK_LABEL;
  function familyOf(key) { return key ? String(key).split(':')[0] : null; }
  R.summarize = function (rows) {
    rows = (rows || []).filter(function (x) { return x && x.reliability && num(x.reliability.score) != null; });
    var scores = rows.map(function (x) { return x.reliability.score; }).sort(function (a, b) { return a - b; });
    var sum = 0; scores.forEach(function (s) { sum += s; });
    var byGrade = {}; R.CONFIG.grades.forEach(function (g) { byGrade[g.key] = 0; });
    var byConf = {}, fbs = { fbs_fbs: [], fbs_fcs: [] };
    var flags = { capped_by_qb: 0, capped_by_stale: 0, missing_weather: 0, missing_venue_coordinates: 0,
      roster_conflicts: 0, unstable_projections: 0, source_disagreement: 0, thin_data: 0, data_fault: 0 };
    var bott = {}, compSum = {}, legacy = [];
    rows.forEach(function (x) {
      var r = x.reliability;
      R.COMPONENT_ORDER.forEach(function (k) { var c = r.components && r.components[k];
        if (c && num(c.score) != null) { var a = compSum[k] || (compSum[k] = { sum: 0, n: 0, max: c.max }); a.sum += c.score; a.n++; } });
      if (num(x.legacy_input_coverage) != null) legacy.push(Math.round(x.legacy_input_coverage * 100));
      byGrade[r.grade] = (byGrade[r.grade] || 0) + 1;
      var confs = [x.home_conference, x.away_conference].filter(Boolean);
      confs.filter(function (v, i) { return confs.indexOf(v) === i; }).forEach(function (cn) { (byConf[cn] = byConf[cn] || []).push(r.score); });
      (x.matchup_type === 'fbs_fcs' ? fbs.fbs_fcs : fbs.fbs_fbs).push(r.score);
      var ids = (r.gates || []).map(function (g) { return g.id; });
      var bound = r.capped_by || [];
      if (bound.some(function (id) { return /^QB_/.test(id); })) flags.capped_by_qb++;
      if (bound.some(function (id) { return /^STALE_/.test(id); })) flags.capped_by_stale++;
      if ((r.missing || []).indexOf('weather') >= 0) flags.missing_weather++;
      if ((r.missing || []).indexOf('venue_coordinates') >= 0 || (r.missing || []).indexOf('travel_coordinates') >= 0) flags.missing_venue_coordinates++;
      if (ids.indexOf('ROSTER_CONFLICT') >= 0) flags.roster_conflicts++;
      if (r.stability && r.stability.tier === 'UNSTABLE') flags.unstable_projections++;
      if ((r.penalties || []).some(function (p) { return p.component === 'source_integrity'; })) flags.source_disagreement++;
      if (ids.indexOf('THIN_DATA') >= 0) flags.thin_data++;
      if (ids.indexOf('DATA_FAULT') >= 0) flags.data_fault++;
      var seen = {};
      (r.penalties || []).forEach(function (p) {
        var fam = p.family || familyOf(p.action_key) || (p.component + ':' + p.item);
        var b = bott[fam] || (bott[fam] = { key: fam, label: BOTTLENECK_LABEL[fam] || fam, games: 0, points: 0 });
        if (!seen[fam]) { b.games++; seen[fam] = 1; }
        b.points += p.points;
      });
    });
    function stats(list) {
      var s = list.slice().sort(function (a, b) { return a - b; }), t = 0;
      s.forEach(function (v) { t += v; });
      return { n: s.length, mean: s.length ? r1(t / s.length) : null, median: pct(s, 0.5) };
    }
    var confOut = Object.keys(byConf).sort().map(function (k) { var s = stats(byConf[k]); s.conference = k; return s; });
    var bl = Object.keys(bott).map(function (k) { bott[k].points = r1(bott[k].points); return bott[k]; })
      .sort(function (a, b) { return (b.games - a.games) || (b.points - a.points) || (a.key < b.key ? -1 : 1); });
    return {
      games: rows.length,
      mean: scores.length ? r1(sum / scores.length) : null,
      median: pct(scores, 0.5),
      percentiles: { p10: pct(scores, 0.1), p25: pct(scores, 0.25), p50: pct(scores, 0.5), p75: pct(scores, 0.75), p90: pct(scores, 0.9) },
      min: scores.length ? scores[0] : null, max: scores.length ? scores[scores.length - 1] : null,
      by_grade: R.CONFIG.grades.map(function (g) { return { grade: g.key, label: g.label, n: byGrade[g.key] || 0 }; }),
      by_conference: confOut,
      fbs_vs_fcs: { fbs_fbs: stats(fbs.fbs_fbs), fbs_fcs: stats(fbs.fbs_fcs) },
      flags: flags,
      components: R.COMPONENT_ORDER.filter(function (k) { return compSum[k]; }).map(function (k) {
        return { key: k, label: LABEL[k], mean: r1(compSum[k].sum / compSum[k].n), max: compSum[k].max }; }),
      /* the number reliability USED to be — the unweighted input-contract
         count — over the same games, so before and after sit side by side */
      legacy_input_coverage: legacy.length ? (function () {
        var s2 = legacy.slice().sort(function (a, b) { return a - b; }), t = 0, modes = {}, top = null;
        s2.forEach(function (v) { t += v; modes[v] = (modes[v] || 0) + 1; });
        Object.keys(modes).forEach(function (k) { if (!top || modes[k] > modes[top]) top = k; });
        return { n: s2.length, mean: r1(t / s2.length), median: pct(s2, 0.5), p10: pct(s2, 0.1), p90: pct(s2, 0.9),
          min: s2[0], max: s2[s2.length - 1], mode: top == null ? null : +top, mode_n: top == null ? 0 : modes[top],
          basis: 'input_coverage: applicable contract fields on file / applicable fields, counted, not weighted (the pre-v2 reliability)' };
      })() : null,
      bottlenecks: bl
    };
  };

  /* ============================================ HISTORICAL CALIBRATION
     Does a higher pregame reliability go with a smaller projection error?
     rows: [{reliability (pregame score), model_margin, close_margin,
     final_margin, week, kickoff}] — every margin home-perspective. The score
     is read as it was published BEFORE the game; nothing here tunes it. */
  R.BUCKETS = [
    { key: '90-100', min: 90, max: 100 }, { key: '80-89', min: 80, max: 89 }, { key: '70-79', min: 70, max: 79 },
    { key: '60-69', min: 60, max: 69 }, { key: '50-59', min: 50, max: 59 }, { key: '<50', min: 0, max: 49 }
  ];
  R.calibrate = function (rows, o) {
    o = o || {};
    var minN = o.min_bucket_n || 30;
    rows = (rows || []).filter(function (x) { return x && num(x.reliability) != null && num(x.model_margin) != null; });
    var out = R.BUCKETS.map(function (b) {
      var xs = rows.filter(function (x) { var s = Math.round(x.reliability); return s >= b.min && s <= b.max; });
      function errs(fn) { return xs.map(fn).filter(function (v) { return num(v) != null; }); }
      var eClose = errs(function (x) { return num(x.close_margin) == null ? null : Math.abs(x.model_margin - x.close_margin); });
      var eRes = errs(function (x) { return num(x.final_margin) == null ? null : Math.abs(x.model_margin - x.final_margin); });
      function mean(a) { if (!a.length) return null; var t = 0; a.forEach(function (v) { t += v; }); return r2(t / a.length); }
      function rmse(a) { if (!a.length) return null; var t = 0; a.forEach(function (v) { t += v * v; }); return r2(Math.sqrt(t / a.length)); }
      function med(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? r2(quantile(s, 0.5)) : null; }
      var favN = 0, favW = 0, atsN = 0, atsW = 0;
      xs.forEach(function (x) {
        if (num(x.final_margin) == null) return;
        if (Math.abs(x.model_margin) >= 0.5 && x.final_margin !== 0) { favN++; if ((x.model_margin > 0) === (x.final_margin > 0)) favW++; }
        if (num(x.close_margin) != null) {
          var gap = x.model_margin - x.close_margin, cover = x.final_margin - x.close_margin;
          if (Math.abs(gap) >= 0.5 && cover !== 0) { atsN++; if ((gap > 0) === (cover > 0)) atsW++; }
        }
      });
      return { bucket: b.key, n: xs.length,
        mae_vs_close: mean(eClose), rmse_vs_close: rmse(eClose), median_abs_vs_close: med(eClose),
        mae_vs_result: mean(eRes), rmse_vs_result: rmse(eRes), median_abs_vs_result: med(eRes),
        favorite_accuracy: favN ? r3(favW / favN) : null, favorite_n: favN,
        ats_research_only: atsN ? r3(atsW / atsN) : null, ats_n: atsN,
        sample_ok: xs.length >= minN };
    });
    /* monotone: among buckets with a usable sample, error should not rise as
       reliability rises */
    function monotone(field) {
      var xs = out.filter(function (b) { return b.sample_ok && num(b[field]) != null; });
      if (xs.length < 3) return { testable: false, why: 'fewer than three buckets hold ' + minN + '+ games' };
      var bad = [];
      for (var i = 0; i + 1 < xs.length; i++) if (xs[i][field] > xs[i + 1][field]) bad.push(xs[i].bucket + ' > ' + xs[i + 1].bucket);
      return { testable: true, monotone: !bad.length, violations: bad };
    }
    var mc = monotone('mae_vs_close'), mr = monotone('mae_vs_result');
    var validated = !!(mc.testable && mc.monotone && mr.testable && mr.monotone);
    return {
      n: rows.length, min_bucket_n: minN, buckets: out,
      monotone_vs_close: mc, monotone_vs_result: mr,
      validated: validated,
      verdict: validated ? 'higher reliability went with lower projection error in every bucket with a usable sample'
        : (!mc.testable || !mr.testable ? 'NOT VALIDATED: too few graded games per reliability bucket to test the ordering'
          : 'NOT VALIDATED: projection error does not fall monotonically as reliability rises'),
      note: 'Reliability is read as published before each game and was never fitted to these outcomes. ATS is research only.'
    };
  };

  return R;
});

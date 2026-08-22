/* ============================================================================
   EdgeDesk CFB Power 4 Intelligence Model — test suite.

   Run under node:      node football/cfb_p4/tests.js      (exit 0 = green)
   Run in the browser:  EDCfbP4Tests.run()                 (returns {passed,failed})

   Three kinds of check, in increasing order of what they protect:

   1. MATHS — odds conversion, de-vig, distributions, key numbers.
   2. PARITY — the rating recursion, the this-season-only track, the scoring
      and efficiency EWMAs and the preseason blend are replayed against
      PYTHON-GENERATED goldens and must agree to 1e-9. If the JS and the
      training pipeline ever drift apart, the shipped seeds stop meaning what
      they say, so this is a build-breaking check.
   3. HONESTY — the invariants that make the model worth trusting:
        * a missing input contributes EXACTLY ZERO to the mean and instead
          widens the distribution,
        * every unavailable measurement carries value:null AND a reason,
        * the edge classifier can never exceed the tier the shipped
          validation record earned,
        * the engine blocks rather than guessing when the season is beyond
          its trained window or a sanity check fails.
   ============================================================================ */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined') ? globalThis : this;
  var isNode = (typeof module !== 'undefined' && module.exports && typeof require === 'function');

  function load() {
    var E = root.EDCfbP4, G = root.EDCfbP4Goldens;
    if (isNode) {
      if (!root.EDCfbP4Params) root.EDCfbP4Params = require('./params.js');
      if (!E) E = require('./engine.js');
      if (!G) { try { G = require('./goldens.json'); root.EDCfbP4Goldens = G; } catch (e) { G = null; } }
    }
    return { E: E, G: G, P: root.EDCfbP4Params };
  }

  function run(verbose) {
    var L = load(), E = L.E, G = L.G, P = L.P;
    var R = [], pass = 0, fail = 0;

    function chk(name, ok, detail) {
      ok = !!ok;
      R.push({ t: name, ok: ok, detail: ok ? undefined : detail });
      if (ok) pass++; else fail++;
    }
    function near(a, b, eps) {
      return isFinite(a) && isFinite(b) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);
    }
    function finish() {
      if (verbose !== false) {
        R.forEach(function (r) {
          if (!r.ok) console.log('FAIL | ' + r.t + '  ' + JSON.stringify(r.detail));
        });
        console.log((fail === 0 ? 'ALL GREEN ' : 'FAILURES ') + pass + ' passed, ' + fail + ' failed');
      }
      return { passed: pass, failed: fail, results: R };
    }

    if (!E || !P) {
      chk('engine + params loaded', false, { E: !!E, P: !!P });
      return finish();
    }

    /* ================= 1. maths ================= */
    chk('amToDec +150', near(E.odds.amToDec(150), 2.5));
    chk('amToDec -110', near(E.odds.amToDec(-110), 1 + 100 / 110, 1e-12));
    chk('decToAm round trip', E.odds.decToAm(E.odds.amToDec(-110)) === -110);
    var dv = E.odds.devigTwoWay(1.909090909, 1.909090909);
    chk('devig even market -> 50/50', dv && near(dv[0], 0.5, 1e-6) && near(dv[1], 0.5, 1e-6));
    var dvp = E.odds.devigTwoWay(1.5, 3.0, 'power');
    chk('power devig sums to 1', dvp && near(dvp[0] + dvp[1], 1, 1e-6));
    chk('EV of a fair bet is 0', near(E.odds.evPct(0.5, 2.0), 0, 1e-12));

    chk('normKey folds accents and punctuation',
      E.normKey('San José State') === 'sanjosestate' && E.normKey('Texas A&M') === 'texasam');
    chk('normKey is stable for the seeds',
      E.normKey('Alabama') === 'alabama');

    /* distributions */
    var D = P.distributions;
    function pmfSum(t) { var s = 0, k; for (k in t) if (t.hasOwnProperty(k)) s += t[k]; return s; }
    chk('margin residual PMF sums to ~1', near(pmfSum(D.margin_resid_pmf), 1, 0.02),
      pmfSum(D.margin_resid_pmf));
    chk('total residual PMF sums to ~1', near(pmfSum(D.total_resid_pmf), 1, 0.02),
      pmfSum(D.total_resid_pmf));
    var anySpreadKey = Object.keys(D.margin_pmf_by_spread)[0];
    chk('spread-conditioned PMF sums to ~1',
      near(pmfSum(D.margin_pmf_by_spread[anySpreadKey]), 1, 0.02));
    chk('key-number mass is CFB-specific, not borrowed',
      D.abs_margin_key_mass && D.abs_margin_key_mass['3'] > 0 && D.abs_margin_key_mass['7'] > 0);
    chk('margin 3 carries more mass than margin 2 (a real football fact)',
      D.abs_margin_key_mass['3'] > D.abs_margin_key_mass['2']);

    var sig = D.sigma_margin;
    chk('win probability at a pick’em is 50%', near(E.dist.winProb(0, sig), 0.5, 1e-9));
    chk('win probability rises with the spread',
      E.dist.winProb(7, sig) > E.dist.winProb(3, sig)
      && E.dist.winProb(3, sig) > E.dist.winProb(0, sig));
    chk('win probability stays inside (0,1) at extremes',
      E.dist.winProb(60, sig) < 1 && E.dist.winProb(-60, sig) > 0);
    chk('fairSpreadFromWinProb inverts winProb',
      near(E.dist.fairSpreadFromWinProb(E.dist.winProb(6.5, sig), sig), 6.5, 1e-4));

    var cov = E.dist.coverProbSpread(7, 7, sig, sig);
    chk('cover probabilities sum to 1', cov && near(cov.win + cov.push + cov.lose, 1, 1e-9));
    chk('a pick’em spread at the projection is near 50/50 excluding pushes',
      (function () {
        var c = E.dist.coverProbSpread(0, 0, sig, sig);
        return c && Math.abs(c.win - c.lose) < 0.08;
      })());
    chk('laying fewer points can never be worth less',
      (function () {
        var v = E.dist.halfPointValue(7, 7.5, 6.5, sig, sig);
        return v !== null && v > 0;
      })());
    var ov = E.dist.coverProbTotal(55, 55, 'over');
    var un = E.dist.coverProbTotal(55, 55, 'under');
    chk('over and under are mirror images', ov && un && near(ov.win, un.lose, 1e-12));

    var md = E.dist.marginDistribution(6, sig);
    chk('margin distribution normalises', md && near(md.reduce(function (a, b) { return a + b[1]; }, 0), 1, 1e-9));
    chk('p10 < median < p90',
      md && E.dist.quantile(md, 0.10) < E.dist.quantile(md, 0.5)
      && E.dist.quantile(md, 0.5) < E.dist.quantile(md, 0.90));
    chk('a more volatile game has a wider range',
      (function () {
        var lo = E.dist.marginDistribution(6, sig * 0.85);
        var hi = E.dist.marginDistribution(6, sig * 1.5);
        var wLo = E.dist.quantile(lo, 0.9) - E.dist.quantile(lo, 0.1);
        var wHi = E.dist.quantile(hi, 0.9) - E.dist.quantile(hi, 0.1);
        return wHi > wLo;
      })());

    /* ================= 2. python parity ================= */
    if (!G) {
      chk('goldens.json present (run research/gen_goldens.py)', false);
    } else {
      var st = E.newState();
      chk('newState builds from the shipped seeds', !!st && !!st.r && !!st.hp);
      var s0 = G.steps[0].state, t, f, okSeed = true, badSeed = null;
      for (var i = 0; i < G.teams.length; i++) {
        t = G.teams[i];
        if (!near(E.strength.rating(st, t, true), s0.r[t], 1e-9)) { okSeed = false; badSeed = t; }
      }
      chk('seeded ratings match python', okSeed, badSeed);
      chk('seeded league mean matches python', near(st.lmeanPts, s0.lmean, 1e-9));

      E.strength.seasonBreak(st);
      var s1 = G.steps[1].state, okBreak = true, badBreak = null;
      for (i = 0; i < G.teams.length; i++) {
        t = G.teams[i];
        if (!near(E.strength.rating(st, t, true), s1.r[t], 1e-9)) { okBreak = false; badBreak = t; }
        if (!near(E.strength.freshRating(st, t, true), s1.rf[t], 1e-9)) { okBreak = false; badBreak = t + ':fresh'; }
        var sc = st.scoring[t] || { pf: 0, pa: 0 };
        if (!near(sc.pf, s1.scoring[t].pf, 1e-9) || !near(sc.pa, s1.scoring[t].pa, 1e-9)) {
          okBreak = false; badBreak = t + ':scoring';
        }
      }
      chk('season carry-over matches python', okBreak, badBreak);

      var okPred = true, badPred = null, okStep = true, badStep = null;
      for (var s = 0; s < G.script.length; s++) {
        var sc2 = G.script[s], pr = G.predictions[s];
        var pm = E.strength.predictMargin(st, sc2.home, sc2.away, true, true, sc2.hfa);
        var fm = E.strength.freshRating(st, sc2.home, true) - E.strength.freshRating(st, sc2.away, true) + sc2.hfa;
        var pt = E.strength.predictScoring(st, sc2.home, sc2.away);
        if (!near(pm, pr.pred_margin, 1e-9)) { okPred = false; badPred = 'margin@' + s; }
        if (!near(fm, pr.fresh_margin, 1e-9)) { okPred = false; badPred = 'fresh@' + s; }
        if (pr.pred_total !== null && !near(pt, pr.pred_total, 1e-9)) { okPred = false; badPred = 'total@' + s; }

        E.strength.absorb(st, {
          home: sc2.home, away: sc2.away, home_fbs: true, away_fbs: true,
          neutral: false, hfa: sc2.hfa,
          margin: sc2.home_points - sc2.away_points,
          home_points: sc2.home_points, away_points: sc2.away_points,
          team_stats: (function () { var o = {}; o[sc2.home] = sc2.home_stats; o[sc2.away] = sc2.away_stats; return o; })()
        });
        var exp = G.steps[s + 2].state;
        for (i = 0; i < G.teams.length; i++) {
          t = G.teams[i];
          if (!near(E.strength.rating(st, t, true), exp.r[t], 1e-9)) { okStep = false; badStep = t + ':r@' + s; }
          if (!near(E.strength.freshRating(st, t, true), exp.rf[t], 1e-9)) { okStep = false; badStep = t + ':rf@' + s; }
          if (E.strength.games(st, t) !== exp.n[t]) { okStep = false; badStep = t + ':n@' + s; }
          var scx = st.scoring[t] || { pf: 0, pa: 0 };
          if (!near(scx.pf, exp.scoring[t].pf, 1e-9)) { okStep = false; badStep = t + ':pf@' + s; }
          for (var fi = 0; fi < G.feats.length; fi++) {
            f = G.feats[fi];
            var got = (st.eff[t] && st.eff[t][f] !== undefined) ? st.eff[t][f] : 0;
            if (!near(got, exp.eff[t][f], 1e-9)) { okStep = false; badStep = t + ':' + f + '@' + s; }
          }
        }
        if (!near(st.lmeanPts, exp.lmean, 1e-9)) { okStep = false; badStep = 'lmean@' + s; }
      }
      chk('pregame predictions match python to 1e-9', okPred, badPred);
      chk('rating / scoring / efficiency recursions match python to 1e-9', okStep, badStep);

      var okBlend = true, badBlend = null;
      for (i = 0; i < G.blend.length; i++) {
        var b = G.blend[i];
        st.gamesThisSeason = st.gamesThisSeason || {};
        st.gamesThisSeason['alabama'] = b.games_played;
        var got2 = E.strength.blendedRating(st, 'alabama', true, null);
        if (!near(got2.prior_weight, b.w, 1e-9) || !near(got2.value, b.value, 1e-9)) {
          okBlend = false; badBlend = 'gp=' + b.games_played;
        }
      }
      chk('preseason blend curve matches python', okBlend, badBlend);
    }

    /* ================= 3. honesty ================= */
    var state = E.newState();
    var teams = Object.keys(P.rating.seed_ratings);
    var HOME = teams.indexOf('alabama') >= 0 ? 'Alabama' : teams[0];
    var AWAY = teams.indexOf('georgia') >= 0 ? 'Georgia' : teams[1];

    function baseReq(extra) {
      var r = {
        season: P.trained_through_season, week: 6, state: state,
        game: { home: HOME, away: AWAY, neutral_site: false, kickoff: '2025-10-11T19:00:00Z' },
        teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } },
        market: {}
      };
      if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k]; }
      return r;
    }

    var p = E.projectGame(baseReq());
    chk('a bare request still projects', p.status === 'PREDICTED', p);
    if (p.status === 'PREDICTED') {
      chk('spec output: spread, total, both win probabilities, both fair moneylines',
        typeof p.model.fair_spread === 'number'
        && p.model.home_win_prob > 0 && p.model.home_win_prob < 1
        && near(p.model.home_win_prob + p.model.away_win_prob, 1, 1e-12)
        && typeof p.model.fair_home_ml === 'number' && typeof p.model.fair_away_ml === 'number');
      chk('spec output: every 0-100 score is present or explicitly null',
        'confidence' in p.scores && 'volatility' in p.scores
        && 'roster_stability' in p.scores && 'injury_uncertainty' in p.scores
        && 'rivalry_intensity' in p.scores && 'scheme_fit' in p.scores
        && 'qb_stability_home' in p.scores && 'schedule_stress_home' in p.scores);
      chk('spec output: the explanation has drivers, counterarguments, unknowns and data quality',
        p.explanation && p.explanation.primary_drivers && p.explanation.counterarguments.length >= 1
        && p.explanation.unpredictable_variables.length >= 1 && p.explanation.data_quality);
      chk('explanation speaks football, not latent variables',
        p.explanation.summary.indexOf('latent') < 0 && p.explanation.summary.length > 40);
      chk('sigma is inside the trained bounds',
        p.model.sigma_margin >= P.volatility.sigma_floor - 1e-9
        && p.model.sigma_margin <= P.volatility.sigma_ceiling + 1e-9,
        p.model.sigma_margin);
      chk('confidence and volatility are separate numbers, not one dressed as two',
        p.scores.confidence !== p.scores.volatility);

      /* THE core invariant */
      var missing = p.contributions.filter(function (c) { return !c.available; });
      chk('every unavailable contribution is exactly 0 points',
        missing.length > 0 && missing.every(function (c) { return c.points === 0; }),
        missing.map(function (c) { return [c.key, c.points]; }));
      chk('every unavailable contribution states WHY',
        missing.every(function (c) { return typeof c.reason === 'string' && c.reason.length > 5; }),
        missing.map(function (c) { return c.key + ':' + c.reason; }));
      chk('an unknown QB is treated as maximum QB uncertainty, not average',
        p.layers.qb.home.uncertainty.value === 1 && p.layers.qb.home.value.available === false);
      chk('an unsupplied injury report is maximum injury uncertainty, not zero',
        p.scores.injury_uncertainty === 100);
      chk('unsupplied off-field reporting is not read as calm',
        p.layers.off_field.home.information_confidence.available === false);
      chk('the blue-chip layer is dark and says why',
        p.layers.talent.home.blue_chip.available === false
        && /recruit/i.test(p.layers.talent.home.blue_chip.reason));
    }

    /* supplying MORE information must not silently change the layers that
       were already available, and must not lower the uncertainty of layers
       that are still missing */
    var pQb = E.projectGame(baseReq({
      teams: {
        home: { conference: 'SEC', qb: { player: 'Test QB', starts: 24, attempts: 900,
          season_epa_per_db: 0.22, returning_starter: true } },
        away: { conference: 'SEC', qb: { player: 'Other QB', starts: 3, attempts: 90,
          season_epa_per_db: -0.05, returning_starter: false } }
      }
    }));
    if (p.status === 'PREDICTED' && pQb.status === 'PREDICTED') {
      chk('the rating contribution is unchanged when a QB is added',
        near(p.contributions[0].points, pQb.contributions[0].points, 1e-12));
      chk('a better QB moves the number toward his team',
        pQb.model.fair_spread > p.model.fair_spread);
      chk('knowing both QBs reduces volatility',
        pQb.model.sigma_margin <= p.model.sigma_margin + 1e-9,
        [p.model.sigma_margin, pQb.model.sigma_margin]);
      chk('knowing both QBs raises confidence',
        pQb.scores.confidence >= p.scores.confidence);
    }

    /* market discipline */
    var pm2 = E.projectGame(baseReq({ market: { spread_line: 21.5, total_line: 55.5 } }));
    if (p.status === 'PREDICTED' && pm2.status === 'PREDICTED') {
      chk('the market NEVER moves the model’s own number',
        near(p.model.fair_spread, pm2.model.fair_spread, 1e-12));
      chk('the market gap is reported separately',
        near(pm2.market.spread_gap, pm2.model.fair_spread - 21.5, 1e-9));
      var tier = P.validation_summary.market.max_tier;
      chk('the edge classifier can never exceed the earned tier',
        ['PASS', 'NO_MARKET', 'PASS_LOW_CONFIDENCE', tier].indexOf(pm2.edge.spread.recommendation) >= 0,
        pm2.edge.spread.recommendation);
      chk('validated matches the shipped record exactly',
        pm2.edge.spread.validated === !!P.validation_summary.market.beats_closing_line);
      chk('unproven flag matches the shipped record',
        pm2.unproven === !P.validation_summary.market.beats_closing_line);
    }

    /* gates */
    var future = E.projectGame(baseReq({ season: P.trained_through_season + 5 }));
    chk('a season beyond the trained window is BLOCKED, not guessed',
      future.status === 'BLOCKED' && /trained through/i.test(future.reason || ''));
    var same = E.projectGame({ season: P.trained_through_season, state: state,
      game: { home: HOME, away: HOME } });
    chk('a team cannot play itself', same.status === 'INSUFFICIENT_DATA');
    var noState = E.projectGame({ season: P.trained_through_season, game: { home: HOME, away: AWAY } });
    chk('no rating state -> INSUFFICIENT_DATA, never a number',
      noState.status === 'INSUFFICIENT_DATA' && noState.missing.indexOf('rating_state') >= 0);

    var broken = E.newState();
    broken.r[E.normKey(HOME)] = 5000;
    var insane = E.projectGame({ season: P.trained_through_season, week: 6, state: broken,
      game: { home: HOME, away: AWAY }, teams: { home: {}, away: {} } });
    chk('an absurd state is BLOCKED by the sanity gate', insane.status === 'BLOCKED');

    /* neutral sites and venues */
    var neutral = E.projectGame(baseReq({ game: { home: HOME, away: AWAY, neutral_site: true } }));
    if (neutral.status === 'PREDICTED') {
      chk('a neutral site gets exactly zero home-field advantage',
        neutral.layers.situation.venue_hfa.value === 0);
    }

    /* fingerprint */
    chk('the fingerprint is stable for identical inputs',
      E.projectGame(baseReq()).fingerprint === E.projectGame(baseReq()).fingerprint);
    chk('the fingerprint changes when the market changes',
      E.projectGame(baseReq({ market: { spread_line: 3 } })).fingerprint
      !== E.projectGame(baseReq({ market: { spread_line: 4 } })).fingerprint);

    /* provenance and record must ship WITH the parameters */
    chk('provenance ships with the parameters', !!P.data_provenance && !!P.data_provenance.betting);
    chk('the validation record ships with the parameters',
      !!P.validation_summary && !!P.validation_summary.market
      && typeof P.validation_summary.market.beats_closing_line === 'boolean');
    chk('what is deliberately unavailable is written down',
      !!P.unavailable_by_design && !!P.unavailable_by_design.weather_coefficients);
    chk('the P4 universe is season-accurate (2024 realignment present)',
      (function () {
        var b = P.universe.p4_by_season['2024'];
        return b && b['Big Ten'] && b['Big Ten'].indexOf('oregon') >= 0
          && b['ACC'] && b['ACC'].indexOf('stanford') >= 0;
      })());
    chk('venue geography ships for the P4 (travel and weather need it)',
      Object.keys(P.universe.venues).length > 60);

    /* ================================================================
       Terms that failed out of sample must not move the number.
       Each of these was applied by an earlier build, and each was
       refuted by execution rather than by opinion.
       ================================================================ */
    chk('rivalry ships with a ZERO mean adjustment on every pair',
      (function () {
        var ps = P.rivalry.pairs || {}, k;
        for (k in ps) if (ps[k].mean_points) return false;
        return Object.keys(ps).length > 100;
      })(),
      'a per-pair constant that always favours the same side is the '
      + '"Team A always beats Team B" adjustment the layer must not be');
    chk('the rivalry record says WHY the mean adjustment was rejected',
      /REJECTED/.test((P.validation_summary.rivalry || {}).mean_points_verdict || ''));

    chk('travel is measured but NOT applied',
      P.travel && P.travel.points_applied === false
      && /NOT APPLIED/.test(P.travel.basis || ''));
    chk('travel contributes exactly 0 points to a real projection',
      (function () {
        var st = E.strength.newState();
        var o = E.projectGame({ season: P.trained_through_season, week: 6, state: st,
          game: { home: 'Alabama', away: 'Auburn', neutral_site: false },
          teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } },
          venue: { home: { lat: 33.2, lon: -87.5, tz: -6, elev: 70 },
                   away: { lat: 32.6, lon: -85.5, tz: -6, elev: 200 } } });
        if (o.status !== 'PREDICTED') return false;
        var t = null, i;
        for (i = 0; i < o.contributions.length; i++)
          if (o.contributions[i].key === 'travel') t = o.contributions[i];
        return t && t.points === 0 && /NOT applied|not applied/.test(
          (o.layers.situation.travel.points.reason || '') + (t.basis || ''));
      })(),
      'travel raised held-out MAE at every specification and two of its three '
      + 'coefficients reverse sign after the tune window');

    /* ================================================================
       A team the model has never rated gets a refusal, not a number.
       ================================================================ */
    chk('an unrated FBS team produces INSUFFICIENT_DATA, never a spread',
      (function () {
        var st = E.strength.newState();
        var o = E.projectGame({ season: P.trained_through_season, week: 1, state: st,
          game: { home: 'Zzz Nonexistent State', away: 'Alabama', neutral_site: false },
          teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } } });
        return o.status === 'INSUFFICIENT_DATA' && !o.model
          && (o.unrated_teams || []).length === 1;
      })(),
      'falling back to init_rating would publish a confident number for a team '
      + 'the model has never seen');
    chk('two unrated teams are both named in the refusal',
      (function () {
        var st = E.strength.newState();
        var o = E.projectGame({ season: P.trained_through_season, week: 1, state: st,
          game: { home: 'Podunk Tech', away: 'Nowhere A&M', neutral_site: false },
          teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } } });
        return o.status === 'INSUFFICIENT_DATA' && (o.unrated_teams || []).length === 2;
      })());

    /* ================================================================
       The distributional layer is a distribution, and it was not fitted
       on the window it is reported on.
       ================================================================ */
    chk('every spread-conditioned PMF bucket sums to 1',
      (function () {
        var t = P.distributions.margin_pmf_by_spread, k, m, sum, n = 0;
        for (k in t) {
          sum = 0;
          for (m in t[k]) sum += t[k][m];
          if (Math.abs(sum - 1) > 1e-5) return false;
          n++;
        }
        return n > 100;
      })(),
      'cover and no-cover have to add up');
    chk('sigma was fitted OUTSIDE the window its score is reported on',
      (function () {
        var w = P.validation_summary.winprob || {};
        return /fitted on 2014-2021/.test(w.basis || '') && w.window === '2022-2025';
      })(),
      'a maximum-likelihood fit scored on its own fitting window reports its '
      + 'objective, not evidence');
    chk('the firewall record names the distributional window',
      /2014-2021/.test((P.validation_summary.firewall || {}).distributional || ''));

    /* ================================================================
       The headline must describe what the engine publishes.
       ================================================================ */
    chk('the headline measures the engine output, not a proxy for it',
      (function () {
        var m = P.validation_summary.market || {};
        return /engine\.js publishes/.test(m.measures || '')
          && m.engine_replay && m.engine_replay.n_projected > 2000;
      })(),
      'train_p4.py scores blended_margin; engine.js publishes a nine-term sum');
    chk('the rating core is reported beside the engine, not instead of it',
      (function () {
        var c = (P.validation_summary.market || {}).core_only || {};
        return c.spread_mae_model > 0
          && c.spread_mae_model !== P.validation_summary.market.spread_mae_model;
      })());

    return finish();
  }

  var API = { run: run };
  root.EDCfbP4Tests = API;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
    if (require.main === module) {
      var r = run(true);
      process.exit(r.failed === 0 ? 0 : 1);
    }
  }
})();

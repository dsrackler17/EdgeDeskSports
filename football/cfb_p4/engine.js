/* ============================================================================
   EdgeDesk CFB Power 4 Intelligence Model — deterministic client engine.

   College football is not the NFL with different logos. This engine models it
   as what it is: an ecosystem of 18-22 year olds, recruiting gaps, portal
   churn, coordinator turnover, uneven schedules and extreme environments —
   where the INSTABILITY IS PART OF THE SIGNAL, not noise to be smoothed away.

   FIVE LAYERS, KEPT SEPARATE ON PURPOSE
     L1 strength     what the team has actually done, opponent-adjusted
     L2 talent       who is actually available to play
     L3 situation    what is happening around this specific game
     L4 matchup      how these two teams interact stylistically
     L5 uncertainty  how much the model should trust its own estimate

   Nothing collapses into one opaque number. Every layer publishes its own
   interpretable subrating, and every subrating is a TYPED MEASUREMENT:

       { value, available, confidence, n, source, as_of, basis, reason }

   THE RULE THAT MAKES THIS HONEST
     A missing input NEVER moves the mean. It contributes 0.0 points and
     instead WIDENS the predictive distribution through the volatility layer.
     A model that guesses an injury is worse than a model that says "I do not
     know who is playing, so this number is worth less than usual".

   WHAT THIS ENGINE WILL NEVER DO
     Invent injuries, NIL figures, depth charts, transfer status, coaching
     decisions, locker-room reports, weather or statistics. Those inputs are
     accepted from the caller with a source and a timestamp, or they are
     declared UNAVAILABLE and priced as uncertainty. There is no third path.

   Every constant lives in params.js and was learned by football/cfb_p4/
   research/*.py from public data whose provenance ships inside that file.
   The recursions here are byte-for-byte mirrors of the python reference;
   tests.js replays python-generated goldens and requires 1e-9 agreement.

   Runs in the browser (window.EDCfbP4) and in node (module.exports).
   ES5-only on purpose: it matches the app it ships inside.
   ========================================================================== */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined') ? globalThis : this;

  var ENGINE_ID = 'edgedesk_cfb_p4';

  function params() {
    var p = root.EDCfbP4Params;
    if (!p && typeof require === 'function') {
      try { p = require('./params.js'); } catch (e) { /* browser path */ }
    }
    return p || null;
  }

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  /* ---------------------------------------------------------------------
     canonical team key — MUST mirror research/common.py:norm() exactly, or
     the shipped seeds will not find their own teams.
     --------------------------------------------------------------------- */
  var ACCENTS = { 'é': 'e', 'í': 'i', 'á': 'a', 'ó': 'o',
    'ú': 'u', 'ñ': 'n', '’': "'", '‘': "'" };
  function normKey(name) {
    if (name == null) return null;
    var s = String(name).trim().toLowerCase(), out = '', i, c;
    for (i = 0; i < s.length; i++) { c = s.charAt(i); out += (ACCENTS[c] || c); }
    out = out.replace(/[^a-z0-9]+/g, '');
    return out || null;
  }

  /* =====================================================================
     TYPED MEASUREMENT
     Every quantity the engine derives carries whether it is real, how much
     it should be trusted, and where it came from. `M.missing(reason)` is a
     first-class value — the engine is designed to say "I don't know".
     ===================================================================== */
  function M(value, opts) {
    opts = opts || {};
    var ok = isNum(value);
    return {
      value: ok ? value : null,
      available: ok,
      confidence: ok ? clamp(isNum(opts.confidence) ? opts.confidence : 1, 0, 1) : 0,
      n: isNum(opts.n) ? opts.n : null,
      source: opts.source || null,
      as_of: opts.as_of || null,
      basis: opts.basis || null,
      reason: ok ? null : (opts.reason || 'not supplied')
    };
  }
  M.missing = function (reason, source) {
    return { value: null, available: false, confidence: 0, n: null,
      source: source || null, as_of: null, basis: null, reason: reason };
  };
  /* points contribution of a measurement: unavailable contributes NOTHING */
  function pts(m) { return (m && m.available && isNum(m.value)) ? m.value : 0; }
  function avail(m) { return !!(m && m.available); }

  /* =====================================================================
     SHARED MATH — odds, distributions
     ===================================================================== */
  var odds = {
    amToDec: function (a) { return a > 0 ? a / 100 + 1 : 100 / (-a) + 1; },
    decToAm: function (d) { return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); },
    implied: function (dec) { return dec > 1 ? 1 / dec : null; },
    devigTwoWay: function (decA, decB, method) {
      if (!(decA > 1) || !(decB > 1)) return null;
      var qa = 1 / decA, qb = 1 / decB, S = qa + qb, lo, hi, k, i;
      if (method === 'power') {
        lo = 0.5; hi = 6;
        for (i = 0; i < 80; i++) {
          k = (lo + hi) / 2;
          if (Math.pow(qa, k) + Math.pow(qb, k) > 1) lo = k; else hi = k;
        }
        k = (lo + hi) / 2;
        return [Math.pow(qa, k), Math.pow(qb, k)];
      }
      return [qa / S, qb / S];
    },
    evPct: function (prob, dec) { return isNum(prob) && dec > 1 ? prob * dec - 1 : null; },
    clv: function (entryDec, closingFairProb) {
      return (entryDec > 1 && isNum(closingFairProb)) ? closingFairProb * entryDec - 1 : null;
    }
  };

  function erf(x) {                       /* A&S 7.1.26, |err| <= 1.5e-7 */
    var s = x < 0 ? -1 : 1; x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

  function pmfEntries(pmf) {
    var out = [], k;
    for (k in pmf) if (has(pmf, k)) out.push([parseInt(k, 10), pmf[k]]);
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }

  var dist = {
    /* Win probability from the fair spread AND this game's own sigma. Two
       games with the same projected margin do NOT have the same win
       probability if one is a veteran-vs-veteran rematch and the other is
       two new-QB teams in a rivalry gale. That is the whole point of L5. */
    winProb: function (fairSpread, sigma) {
      if (!isNum(fairSpread) || !(sigma > 0)) return null;
      return normCdf(fairSpread / sigma);
    },
    fairSpreadFromWinProb: function (p, sigma) {
      if (!(p > 0 && p < 1) || !(sigma > 0)) return null;
      var lo = -80, hi = 80, m, i;
      for (i = 0; i < 60; i++) {
        m = (lo + hi) / 2;
        if (normCdf(m / sigma) < p) lo = m; else hi = m;
      }
      return (lo + hi) / 2;
    },
    /* P(home covers `line`). Primary path is the LEARNED margin PMF
       conditioned on the market spread — CFB key numbers are real but they
       are NOT the NFL's, and a pooled residual table smears them away.
       When this game's sigma differs from the table's baseline the PMF is
       stretched about the line, so a high-volatility game does not borrow a
       low-volatility game's key-number mass. */
    coverProbSpread: function (fairSpread, line, sigma, sigmaBase) {
      var P = params(); if (!P) return null;
      var D = P.distributions;
      if (!D || !isNum(fairSpread) || !isNum(line)) return null;
      var tab = D.margin_pmf_by_spread, rng = D.pmf_spread_range;
      var stretch = (isNum(sigma) && isNum(sigmaBase) && sigmaBase > 0) ? sigma / sigmaBase : 1;
      var win = 0, push = 0, tot = 0, i, es, key, pmf, need, m;
      if (tab && rng && fairSpread >= rng[0] && fairSpread <= rng[1]) {
        key = (Math.round(fairSpread * 2) / 2).toFixed(1);
        if (key === '-0.0') key = '0.0';
        pmf = tab[key] || tab[Math.round(fairSpread).toFixed(1)];
        if (pmf) {
          es = pmfEntries(pmf);
          for (i = 0; i < es.length; i++) {
            /* stretch about the projection, keeping integer margins integral
               so key numbers survive: only the WEIGHTS move, never the grid */
            m = es[i][0];
            tot += es[i][1];
            if (Math.abs(m - line) < 1e-9) push += es[i][1];
            else if (m > line) win += es[i][1];
          }
          if (tot > 0.5 && Math.abs(stretch - 1) < 0.02) {
            return { win: win / tot, push: push / tot,
              lose: 1 - (win + push) / tot, basis: 'margin_pmf_by_spread' };
          }
          if (tot > 0.5) {
            /* volatility-adjusted: reweight the same grid by the ratio of
               normal densities at the game sigma vs the table baseline */
            var w2 = 0, p2 = 0, t2 = 0, z0, z1, wgt;
            for (i = 0; i < es.length; i++) {
              m = es[i][0];
              z0 = (m - fairSpread) / (sigmaBase || 1);
              z1 = (m - fairSpread) / (sigma || 1);
              wgt = es[i][1] * Math.exp(-0.5 * (z1 * z1 - z0 * z0)) / stretch;
              t2 += wgt;
              if (Math.abs(m - line) < 1e-9) p2 += wgt;
              else if (m > line) w2 += wgt;
            }
            if (t2 > 0) return { win: w2 / t2, push: p2 / t2,
              lose: 1 - (w2 + p2) / t2, basis: 'margin_pmf_by_spread_vol_adj' };
          }
        }
      }
      need = line - fairSpread;
      es = pmfEntries(D.margin_resid_pmf || {});
      win = 0; push = 0; tot = 0;
      for (i = 0; i < es.length; i++) {
        tot += es[i][1];
        if (Math.abs(es[i][0] - need) < 1e-9) push += es[i][1];
        else if (es[i][0] > need) win += es[i][1];
      }
      if (!(tot > 0.5)) return null;
      return { win: win / tot, push: push / tot,
        lose: 1 - (win + push) / tot, basis: 'pooled_residual' };
    },
    coverProbTotal: function (fairTotal, line, side) {
      var P = params(); if (!P || !P.distributions) return null;
      if (!isNum(fairTotal) || !isNum(line)) return null;
      var need = line - fairTotal;
      var es = pmfEntries(P.distributions.total_resid_pmf || {});
      var over = 0, push = 0, tot = 0, i, p;
      for (i = 0; i < es.length; i++) {
        tot += es[i][1];
        if (Math.abs(es[i][0] - need) < 1e-9) push += es[i][1];
        else if (es[i][0] > need) over += es[i][1];
      }
      if (!(tot > 0.5)) return null;
      p = { win: over / tot, push: push / tot, lose: 1 - (over + push) / tot };
      if (side === 'under') p = { win: p.lose, push: p.push, lose: p.win };
      return p;
    },
    keyMass: function () {
      var P = params();
      return (P && P.distributions) ? (P.distributions.abs_margin_key_mass || null) : null;
    },
    halfPointValue: function (fairSpread, fromLine, toLine, sigma, sigmaBase) {
      var a = dist.coverProbSpread(fairSpread, fromLine, sigma, sigmaBase);
      var b = dist.coverProbSpread(fairSpread, toLine, sigma, sigmaBase);
      if (!a || !b) return null;
      return (b.win + 0.5 * b.push) - (a.win + 0.5 * a.push);
    },
    /* full outcome distribution for the simulation section of the spec */
    marginDistribution: function (fairSpread, sigma) {
      var P = params(); if (!P || !P.distributions) return null;
      if (!isNum(fairSpread) || !(sigma > 0)) return null;
      var D = P.distributions, base = D.sigma_margin, out = [], i, m, z, w, tot = 0;
      var es = pmfEntries(D.margin_resid_pmf || {});
      if (!es.length) return null;
      for (i = 0; i < es.length; i++) {
        m = fairSpread + es[i][0];
        z = es[i][0] / (sigma || base);
        w = es[i][1] * Math.exp(-0.5 * (z * z - (es[i][0] / base) * (es[i][0] / base)));
        out.push([m, w]); tot += w;
      }
      for (i = 0; i < out.length; i++) out[i][1] /= tot;
      return out;
    },
    quantile: function (distr, q) {
      if (!distr || !distr.length) return null;
      var c = 0, i;
      for (i = 0; i < distr.length; i++) {
        c += distr[i][1];
        if (c >= q) return distr[i][0];
      }
      return distr[distr.length - 1][0];
    }
  };

  /* =====================================================================
     LAYER 1 — TEAM TRUE RATING
     A capped-margin opponent-adjusted rating in POINTS, plus opponent-
     adjusted efficiency EWMAs (success rate, explosiveness, sack rate,
     havoc, finishing) and scoring EWMAs for the total. Unstable statistics
     (turnovers, fumble recovery, defensive scores) are regressed toward the
     league mean by LEARNED shrinkage — the shrinkage is each statistic's own
     measured week-to-week autocorrelation, not a guess.
     ===================================================================== */
  var EFF_FEATS = null;                    /* filled from params on first use */

  function effFeats() {
    var P = params();
    if (!EFF_FEATS) EFF_FEATS = (P && P.efficiency && P.efficiency.feats) ? P.efficiency.feats : [];
    return EFF_FEATS;
  }

  var strength = {
    newState: function () {
      var P = params(); if (!P) return null;
      var R = P.rating, E = P.efficiency || {};
      var st = {
        engine: ENGINE_ID,
        hp: clone(R.hyperparams),
        r: clone(R.seed_ratings || {}),
        n: clone(R.seed_ngames || {}),
        scoring: clone(R.seed_scoring || {}),
        lmeanPts: R.league_mean_pts,
        eff: clone(E.seed || {}),
        effMean: clone(E.league_means || {}),
        effAlpha: (E.alpha != null ? E.alpha : 0.15),
        seededThrough: P.trained_through_season,
        season: P.trained_through_season,
        absorbed: 0,
        conf: clone(P.conference && P.conference.seed_strength || {})
      };
      /* Two rating tracks run side by side. `r` CARRIES last season forward
         (the model's preseason belief, decayed by the learned carry-over);
         `rf` is WIPED at every season break and knows only what has happened
         this year. Section XXIV is then a measurement rather than a
         schedule: the learned curve says how much of the carried belief to
         keep at each number of games played, and it is what lets the engine
         say out loud that its preseason belief was wrong. */
      st.r0 = clone(st.r);
      st.rf = {};
      st.gamesThisSeason = {};
      return st;
    },
    rating: function (st, teamKey, isFbs) {
      if (isFbs === false) return st.hp.fcs_rating;
      return has(st.r, teamKey) ? st.r[teamKey] : st.hp.init_rating;
    },
    games: function (st, teamKey) { return st.n[teamKey] || 0; },
    /* season rollover: ratings and EWMAs decay toward the mean by the
       LEARNED carry-over. CFB carry-over is far weaker than the NFL's —
       that difference is the portal, the draft and 25% roster replacement,
       and it is measured, not assumed. */
    seasonBreak: function (st) {
      var c = st.hp.carry, ce = (st.hp.carry_eff != null ? st.hp.carry_eff : c), t, f, fs = effFeats(), i;
      for (t in st.r) if (has(st.r, t)) st.r[t] *= c;
      for (t in st.scoring) if (has(st.scoring, t)) {
        st.scoring[t].pf *= c; st.scoring[t].pa *= c;
      }
      for (t in st.eff) if (has(st.eff, t)) {
        for (i = 0; i < fs.length; i++) { f = fs[i]; if (isNum(st.eff[t][f])) st.eff[t][f] *= ce; }
      }
      st.season = (st.season || 0) + 1;
      st.r0 = clone(st.r);          /* the new season's preseason belief */
      st.rf = {};                   /* this-season-only track starts blank */
      st.gamesThisSeason = {};
    },
    freshRating: function (st, teamKey, isFbs) {
      if (isFbs === false) return st.hp.fcs_rating;
      return has(st.rf || {}, teamKey) ? st.rf[teamKey] : st.hp.init_rating;
    },
    /* Section XXIV in one function: what the model believed in August,
       blended against what it has actually seen, on a LEARNED curve. */
    blendedRating: function (st, teamKey, isFbs, week) {
      var carried = strength.rating(st, teamKey, isFbs);
      if (isFbs === false) return { value: carried, prior_weight: 1, carried: carried,
        this_season: carried, games_played: null, basis: 'FCS bucket' };
      var played = (st.gamesThisSeason && st.gamesThisSeason[teamKey]) || 0;
      var fresh = strength.freshRating(st, teamKey, isFbs);
      var pw = priorWeight(week, played);
      var w = isNum(pw.w) ? clamp(pw.w, 0, 1) : 1;
      return { value: w * carried + (1 - w) * fresh, prior_weight: w,
        carried: carried, this_season: fresh, games_played: played, basis: pw.basis };
    },
    predictMargin: function (st, home, away, hFbs, aFbs, hfaPts) {
      return strength.rating(st, home, hFbs) - strength.rating(st, away, aFbs)
        + (isNum(hfaPts) ? hfaPts : 0);
    },
    predictScoring: function (st, home, away) {
      if (!isNum(st.lmeanPts)) return null;
      var oh = st.scoring[home], oa = st.scoring[away];
      if (!oh || !oa) return null;
      return 2 * st.lmeanPts + st.hp.k_total * (oh.pf + oh.pa + oa.pf + oa.pa);
    },
    _eff: function (st, t) {
      if (!st.eff[t]) {
        var o = {}, fs = effFeats(), i;
        for (i = 0; i < fs.length; i++) o[fs[i]] = 0;
        st.eff[t] = o;
      }
      return st.eff[t];
    },
    /* ORDERED absorb. Order is part of the algorithm: league means update
       sequentially, so replaying games out of kickoff order gives a
       different (wrong) state. */
    absorb: function (st, g) {
      var hp = st.hp;
      var hFbs = g.home_fbs !== false, aFbs = g.away_fbs !== false;
      var hfa = g.neutral ? 0 : (isNum(g.hfa) ? g.hfa : hp.hfa);
      var m = clamp(g.margin, -hp.cap, hp.cap);
      var err = m - strength.predictMargin(st, g.home, g.away, hFbs, aFbs, hfa);
      if (!st.gamesThisSeason) st.gamesThisSeason = {};
      if (!st.rf) st.rf = {};
      /* the this-season-only track, with its own learned step size */
      var kf = isNum(hp.k_fresh) ? hp.k_fresh : hp.k;
      var errF = m - (strength.freshRating(st, g.home, hFbs)
        - strength.freshRating(st, g.away, aFbs) + hfa);
      if (hFbs) st.rf[g.home] = strength.freshRating(st, g.home, true) + kf * errF;
      if (aFbs) st.rf[g.away] = strength.freshRating(st, g.away, true) - kf * errF;
      if (hFbs) {
        st.r[g.home] = strength.rating(st, g.home, true) + hp.k * err;
        st.n[g.home] = strength.games(st, g.home) + 1;
        st.gamesThisSeason[g.home] = (st.gamesThisSeason[g.home] || 0) + 1;
        if (!has(st.r0 || {}, g.home)) { st.r0 = st.r0 || {}; st.r0[g.home] = hp.init_rating; }
      }
      if (aFbs) {
        st.r[g.away] = strength.rating(st, g.away, true) - hp.k * err;
        st.n[g.away] = strength.games(st, g.away) + 1;
        st.gamesThisSeason[g.away] = (st.gamesThisSeason[g.away] || 0) + 1;
        if (!has(st.r0 || {}, g.away)) { st.r0 = st.r0 || {}; st.r0[g.away] = hp.init_rating; }
      }

      if (!isNum(st.lmeanPts)) st.lmeanPts = (g.home_points + g.away_points) / 2;
      var rows = [[g.home, g.home_points, g.away_points, hFbs],
                  [g.away, g.away_points, g.home_points, aFbs]], i, t, o, at;
      for (i = 0; i < 2; i++) {
        if (!rows[i][3]) continue;
        t = rows[i][0];
        o = st.scoring[t] || (st.scoring[t] = { pf: 0, pa: 0 });
        at = hp.alpha_total;
        o.pf = (1 - at) * o.pf + at * (rows[i][1] - st.lmeanPts);
        o.pa = (1 - at) * o.pa + at * (rows[i][2] - st.lmeanPts);
      }
      var al = hp.alpha_league;
      st.lmeanPts = (1 - al) * st.lmeanPts + al * ((g.home_points + g.away_points) / 2);

      /* opponent-adjusted efficiency: a team's performance is credited
         against what the OPPONENT normally allows, so 7.0 yards a play
         against a shredded defence is not the same observation as 7.0
         against the best front in the league. */
      if (g.team_stats) strength.absorbEfficiency(st, g);
      st.absorbed = (st.absorbed || 0) + 1;
    },
    absorbEfficiency: function (st, g) {
      var P = params(); if (!P || !P.efficiency) return;
      var CP = P.efficiency.counterpart || {};
      var fs = effFeats(), a = st.effAlpha, aL = P.efficiency.alpha_league || 0.01;
      var sides = [[g.home, g.away], [g.away, g.home]];
      var pre = {}, i, j, t, opp, f, v, lm, cf, perf, raw;
      for (i = 0; i < sides.length; i++) pre[sides[i][0]] = clone(strength._eff(st, sides[i][0]));
      for (i = 0; i < sides.length; i++) {
        t = sides[i][0]; opp = sides[i][1];
        raw = g.team_stats[t];
        if (!raw) continue;
        strength._eff(st, opp);
        for (j = 0; j < fs.length; j++) {
          f = fs[j]; v = raw[f];
          if (!isNum(v)) continue;                 /* NaN skips; never a fake 0 */
          lm = st.effMean[f];
          if (lm == null) { st.effMean[f] = v; continue; }
          cf = CP[f];
          perf = v - lm - (cf && pre[opp] && isNum(pre[opp][cf]) ? pre[opp][cf] : 0);
          st.eff[t][f] = (1 - a) * st.eff[t][f] + a * perf;
          st.effMean[f] = (1 - aL) * lm + aL * v;
        }
      }
    },
    /* the interpretable Layer-1 subrating bundle for one team */
    profile: function (st, teamKey, isFbs) {
      var P = params();
      var n = strength.games(st, teamKey);
      var known = has(st.r, teamKey);
      var conf = clamp(n / ((P && P.rating.games_for_full_confidence) || 6), 0, 1);
      var e = st.eff[teamKey] || null, out = {
        rating: known || isFbs === false
          ? M(strength.rating(st, teamKey, isFbs), { n: n, confidence: conf,
              source: 'opponent-adjusted capped-margin rating', basis: 'results' })
          : M.missing('team not in rating state (never observed)'),
        games: n,
        scoring: st.scoring[teamKey]
          ? M(st.scoring[teamKey].pf, { n: n, confidence: conf, source: 'scoring EWMA (pts for vs league mean)' })
          : M.missing('no scoring history'),
        scoring_allowed: st.scoring[teamKey]
          ? M(st.scoring[teamKey].pa, { n: n, confidence: conf, source: 'scoring EWMA (pts against vs league mean)' })
          : M.missing('no scoring history'),
        efficiency: {}
      };
      var fs = effFeats(), i;
      for (i = 0; i < fs.length; i++) {
        out.efficiency[fs[i]] = (e && isNum(e[fs[i]]))
          ? M(e[fs[i]], { n: n, confidence: conf, source: 'opponent-adjusted EWMA (play-level)' })
          : M.missing('no play-level data absorbed for this team');
      }
      return out;
    },
    /* Section XXI — regression of unstable statistics. The shrinkage factor
       for each statistic IS its measured persistence; a statistic that does
       not repeat is pulled almost entirely to the mean, one that does is
       barely touched. Nothing is regressed "because turnovers are luck". */
    regress: function (statName, observed, leagueMean, n) {
      var P = params();
      var tab = (P && P.regression) || {};
      var r = tab[statName];
      if (!r || !isNum(observed) || !isNum(leagueMean)) {
        return M(isNum(observed) ? observed : null, {
          source: 'raw (no measured persistence for this statistic)',
          confidence: 0.5, basis: 'unregressed' });
      }
      var k = r.shrink_games != null ? r.shrink_games : 0;
      var w = isNum(n) && (n + k) > 0 ? n / (n + k) : 0;
      return M(w * observed + (1 - w) * leagueMean, {
        n: n, confidence: clamp(w, 0.1, 1),
        source: 'regressed to league mean',
        basis: 'measured lag-1 persistence r=' + (r.persistence != null ? r.persistence : '?')
          + ', half-weight at ' + k + ' games' });
    }
  };

  /* =====================================================================
     LAYER 2 — TALENT / ROSTER
     Position-group talent, experience and continuity. The caller supplies a
     roster measurement bundle (built by research/features_roster.py, or by
     the app from the same public rosters). Whatever is absent is absent.
     ===================================================================== */
  /* Position groups as the public roster feed actually spells them. 'DB'
     is kept as its own bucket rather than being arbitrarily folded into
     CB or S: the feed uses it for players whose exact secondary role is
     not specified, and inventing one would be a silent fabrication. */
  var POS_GROUPS = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'EDGE', 'LB', 'CB', 'S',
    'DB', 'K', 'P', 'LS', 'RET', 'ATH'];

  var talent = {
    groups: POS_GROUPS,
    /* r = { by_group: {QB:{n, returning_share, class_mix:{fr,so,jr,sr},
                            returning_production, transfers_in, transfers_out,
                            starts_returning}}, team: {...} } */
    profile: function (r, side) {
      var out = { by_group: {}, overall: null, source: r && r.source || null,
        as_of: r && r.as_of || null };
      var i, gname, g, c;
      var NO_STARS = 'per-player recruiting stars are not present in the public roster feed '
        + '(recruit_ids ships empty); supply them via ingest.setRecruiting() to enable the '
        + 'blue-chip layer';
      if (!r || !r.by_group) {
        for (i = 0; i < POS_GROUPS.length; i++)
          out.by_group[POS_GROUPS[i]] = {
            talent: M.missing('no roster supplied for ' + side),
            experience: M.missing('no roster supplied for ' + side),
            continuity: M.missing('no roster supplied for ' + side),
            returning_production: M.missing('no roster supplied for ' + side),
            portal_in: M.missing('no roster supplied for ' + side),
            portal_out: M.missing('no roster supplied for ' + side)
          };
        out.overall = M.missing('no roster supplied for ' + side);
        out.blue_chip = M.missing(NO_STARS);
        return out;
      }
      for (i = 0; i < POS_GROUPS.length; i++) {
        gname = POS_GROUPS[i]; g = r.by_group[gname];
        if (!g) { out.by_group[gname] = { talent: M.missing(gname + ' not present in roster bundle') }; continue; }
        c = isNum(g.n) ? clamp(g.n / 8, 0.2, 1) : 0.3;
        out.by_group[gname] = {
          talent: isNum(g.talent) ? M(g.talent, { n: g.n, confidence: c, source: r.source,
            basis: g.talent_basis || 'roster composite' })
            : M.missing('no talent measure for ' + gname + ' (per-player recruiting ratings are not in any public feed this engine reads)'),
          experience: isNum(g.experience) ? M(g.experience, { n: g.n, confidence: c, source: r.source, basis: 'class mix' })
            : M.missing('class data absent for ' + gname),
          continuity: isNum(g.returning_share) ? M(g.returning_share, { n: g.n, confidence: c, source: r.source,
            basis: 'athlete_id year-over-year' }) : M.missing('no prior-season roster to diff'),
          returning_production: isNum(g.returning_production)
            ? M(g.returning_production, { n: g.n, confidence: c, source: r.source, basis: 'prior-season production share retained' })
            : M.missing('no prior-season production join'),
          portal_in: isNum(g.transfers_in) ? M(g.transfers_in, { n: g.n, confidence: c, source: r.source }) : M.missing('portal diff unavailable'),
          portal_out: isNum(g.transfers_out) ? M(g.transfers_out, { n: g.n, confidence: c, source: r.source }) : M.missing('portal diff unavailable')
        };
      }
      out.overall = isNum(r.overall_talent)
        ? M(r.overall_talent, { confidence: 0.6, source: r.source, basis: r.overall_basis || 'roster composite' })
        : M.missing('no overall talent composite');
      out.blue_chip = isNum(r.blue_chip_ratio)
        ? M(r.blue_chip_ratio, { confidence: 0.8, source: r.source, basis: 'per-player star ratings supplied by caller' })
        : M.missing(NO_STARS);
      return out;
    },
    /* Section VI — ROSTER STABILITY 0-100. Built only from what is
       observable: continuity, portal churn, QB room and coaching continuity
       IF the caller supplied it. NIL and locker-room reporting are NOT
       inputs here; they are declared unavailable and priced as uncertainty. */
    stability: function (prof, extra) {
      var P = params();
      var w = (P && P.stability && P.stability.weights) || null;
      if (!w) return M.missing('stability weights not trained');
      var parts = [], names = [], i, gname, g, v;
      var groupWeights = (P.stability.group_weights) || {};
      for (i = 0; i < POS_GROUPS.length; i++) {
        gname = POS_GROUPS[i]; g = prof.by_group[gname];
        if (!g || !avail(g.continuity)) continue;
        v = clamp(g.continuity.value, 0, 1);
        parts.push({ w: groupWeights[gname] || 1, v: v, why: gname + ' continuity ' + Math.round(v * 100) + '%' });
        names.push(gname);
      }
      if (!parts.length) return M.missing('no roster continuity observable for either roster');
      var num = 0, den = 0;
      for (i = 0; i < parts.length; i++) { num += parts[i].w * parts[i].v; den += parts[i].w; }
      var base = num / den;
      var coachPenalty = 0, coachKnown = false;
      if (extra && extra.coaching) {
        coachKnown = true;
        if (extra.coaching.new_hc) coachPenalty += w.new_hc || 0;
        if (extra.coaching.new_oc) coachPenalty += w.new_oc || 0;
        if (extra.coaching.new_dc) coachPenalty += w.new_dc || 0;
      }
      var score = clamp(100 * base - 100 * coachPenalty, 0, 100);
      return M(score, {
        confidence: coachKnown ? 0.8 : 0.55,
        n: parts.length,
        source: 'roster continuity' + (coachKnown ? ' + supplied coaching continuity' : ''),
        basis: coachKnown ? 'continuity and staff turnover'
          : 'continuity only — coaching-staff turnover was NOT supplied, so this score '
            + 'cannot see a new staff; the gap is carried in the volatility layer instead'
      });
    },
    /* Section XVII — YOUTH VOLATILITY. Youth is treated as VARIANCE, never
       as a penalty to the mean: young teams are not worse on average, they
       are less predictable. */
    youthVolatility: function (prof) {
      var P = params();
      var w = (P && P.volatility && P.volatility.youth_group_weights) || null;
      if (!w) return M.missing('youth weights not trained');
      var num = 0, den = 0, i, gname, g;
      for (i = 0; i < POS_GROUPS.length; i++) {
        gname = POS_GROUPS[i]; g = prof.by_group[gname];
        if (!g || !avail(g.experience)) continue;
        num += (w[gname] || 0) * (1 - clamp(g.experience.value, 0, 1));
        den += (w[gname] || 0);
      }
      if (!(den > 0)) return M.missing('no class/experience data on this roster');
      return M(clamp(100 * num / den, 0, 100), {
        confidence: 0.7, source: 'roster class mix',
        basis: 'inverse experience, weighted by each position group’s measured variance contribution' });
    }
  };

  /* =====================================================================
     LAYER 3 — SITUATION
     Venue, travel, schedule stress, rivalry, conference.
     ===================================================================== */
  var situation = {
    /* Section XIV — home-field advantage.
       The spec asks for a venue-specific number, and the pipeline builds one
       — then TESTS it. In this data it fails: because a team plays every
       home game at one stadium, whatever the ratings have not yet absorbed
       about that team lands on its venue, and the resulting "venue table"
       correlates 0.77 with the home team's own rating while failing to beat
       a single league constant out of sample. So the table is only shipped
       if it earns its place; when it does not, the league constant is used
       and SAYS SO. That is the spec's instruction — increase uncertainty
       rather than invent certainty — applied to its own request. */
    venueHfa: function (venueId, neutral, homeKey) {
      var P = params(); if (!P || !P.venue) return M.missing('venue table not trained');
      if (neutral) return M(0, { confidence: 1, source: 'neutral site', basis: 'no home venue' });
      var tab = P.venue.hfa_by_venue || {};
      var league = P.venue.league_hfa;
      var v = venueId != null ? tab[String(venueId)] : null;
      if (!v && homeKey && P.venue.hfa_by_team) v = P.venue.hfa_by_team[homeKey];
      if (v && isNum(v.hfa)) {
        return M(v.hfa, { n: v.n, confidence: clamp(v.n / (P.venue.n_for_full_confidence || 40), 0.3, 1),
          source: 'venue history 2001-' + P.trained_through_season,
          basis: 'empirical-Bayes shrunk toward league mean ' + league });
      }
      if (isNum(league)) {
        var rejected = !tab || !Object.keys(tab).length;
        return M(league, { confidence: rejected ? 0.7 : 0.5,
          source: rejected ? 'league home-field advantage' : 'league mean HFA',
          basis: rejected
            ? 'a per-venue table was fitted and rejected: its estimates tracked the home '
              + 'team\u2019s own rating rather than the stadium, and it did not beat this '
              + 'single constant out of sample'
            : 'this venue has no rated history (new stadium, neutral-ish, or unmatched venue_id)' });
      }
      return M.missing('no venue HFA available');
    },
    /* Section XIV/XV — travel. Distance, time zones and altitude are real
       and computable; whether they MOVE the number is an empirical question
       the training answers, and the answer may be "barely". */
    travel: function (homeVenue, awayVenue, neutral) {
      var P = params();
      if (!homeVenue || !awayVenue || !isNum(homeVenue.lat) || !isNum(awayVenue.lat))
        return { miles: M.missing('venue coordinates not supplied for one or both teams'),
                 tz_delta: M.missing('venue timezone not supplied'),
                 altitude_delta: M.missing('venue elevation not supplied'),
                 points: M.missing('travel inputs unavailable') };
      var miles = situation.haversine(awayVenue.lat, awayVenue.lon, homeVenue.lat, homeVenue.lon);
      var tz = (isNum(awayVenue.tz) && isNum(homeVenue.tz)) ? (homeVenue.tz - awayVenue.tz) : null;
      var alt = (isNum(awayVenue.elev) && isNum(homeVenue.elev)) ? (homeVenue.elev - awayVenue.elev) : null;
      var w = (P && P.travel) || null;
      var ptsVal = null;
      if (w && !neutral) {
        ptsVal = (w.per_1000_miles || 0) * (miles / 1000)
          + (w.per_tz_hour || 0) * (isNum(tz) ? Math.abs(tz) : 0)
          + (w.per_1000m_altitude || 0) * (isNum(alt) ? Math.max(0, alt) / 1000 : 0);
      }
      return {
        miles: M(miles, { confidence: 0.95, source: 'venue coordinates (team_info)', basis: 'haversine' }),
        tz_delta: isNum(tz) ? M(tz, { confidence: 0.9, source: 'venue timezone' }) : M.missing('timezone missing for a venue'),
        altitude_delta: isNum(alt) ? M(alt, { confidence: 0.9, source: 'venue elevation (metres)' }) : M.missing('elevation missing for a venue'),
        points: isNum(ptsVal) ? M(ptsVal, { confidence: w && w.confidence != null ? w.confidence : 0.4,
          source: 'learned travel coefficients', basis: w && w.basis || 'walk-forward residual regression' })
          : M.missing(neutral ? 'neutral site — no travel asymmetry modelled' : 'travel coefficients not trained')
      };
    },
    haversine: function (lat1, lon1, lat2, lon2) {
      var R = 3958.7613, d2r = Math.PI / 180;
      var p1 = lat1 * d2r, p2 = lat2 * d2r;
      var dp = p2 - p1, dl = (lon2 - lon1) * d2r;
      var a = Math.sin(dp / 2) * Math.sin(dp / 2)
        + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
      return 2 * R * Math.asin(Math.sqrt(clamp(a, 0, 1)));
    },
    /* Section XV — SCHEDULE STRESS 0-100 from what the schedule itself
       shows. Every component is pregame-computable; nothing peeks forward
       except the identity (not the result) of the next opponent. */
    scheduleStress: function (s) {
      var P = params(); if (!P || !P.schedule) return M.missing('schedule-stress weights not trained');
      if (!s) return M.missing('no schedule context supplied for this side');
      var w = P.schedule.weights, acc = 0, den = 0, why = [], k, v;
      var comps = {
        short_rest: isNum(s.rest_days) ? clamp((7 - s.rest_days) / 7, 0, 1) : null,
        off_bye: isNum(s.rest_days) ? (s.rest_days >= 12 ? 1 : 0) : null,
        consec_road: isNum(s.consecutive_road) ? clamp(s.consecutive_road / 3, 0, 1) : null,
        road_last3: isNum(s.road_last3) ? clamp(s.road_last3 / 3, 0, 1) : null,
        miles_last3: isNum(s.miles_last3) ? clamp(s.miles_last3 / 4000, 0, 1) : null,
        tz_last3: isNum(s.tz_changes_last3) ? clamp(s.tz_changes_last3 / 4, 0, 1) : null,
        prev_opponent_strength: isNum(s.prev_opp_rating) ? clamp((s.prev_opp_rating + 20) / 40, 0, 1) : null,
        lookahead: isNum(s.next_opp_rating) ? clamp((s.next_opp_rating + 20) / 40, 0, 1) : null
      };
      for (k in comps) if (has(comps, k)) {
        v = comps[k];
        if (v == null || !isNum(w[k])) continue;
        acc += w[k] * v; den += Math.abs(w[k]);
        if (v > 0.5) why.push(k.replace(/_/g, ' '));
      }
      if (!(den > 0)) return M.missing('no schedule components computable');
      return M(clamp(100 * acc / den, 0, 100), {
        confidence: clamp(den / 3, 0.3, 1), source: 'schedule geometry',
        basis: why.length ? why.join(', ') : 'no elevated component' });
    },
    /* Section XVI — RIVALRY, DETECTED FROM DATA, NEVER ASSERTED.
       A rivalry here is a pair whose meeting frequency, proximity and
       measured residual behaviour mark it out. History is used to identify
       persistent SITUATIONAL BEHAVIOUR, never as "Team A always beats Team
       B" — the intensity feeds volatility, and any mean effect is whatever
       the walk-forward measured, which may be ~0. */
    rivalry: function (homeKey, awayKey) {
      var P = params(); if (!P || !P.rivalry) return {
        intensity: M.missing('rivalry table not trained'), volatility: M.missing('rivalry table not trained'),
        points: M.missing('rivalry table not trained') };
      var key = [homeKey, awayKey].sort().join('|');
      var r = P.rivalry.pairs ? P.rivalry.pairs[key] : null;
      if (!r) return {
        intensity: M(0, { confidence: 0.9, source: 'rivalry detector', basis: 'pair not detected as a rivalry' }),
        volatility: M(0, { confidence: 0.9, source: 'rivalry detector', basis: 'pair not detected as a rivalry' }),
        points: M(0, { confidence: 0.9, source: 'rivalry detector', basis: 'no rivalry adjustment' })
      };
      return {
        intensity: M(r.intensity, { n: r.n, confidence: clamp(r.n / 20, 0.3, 1),
          source: 'meeting frequency, proximity and measured residual behaviour 2001-' + P.trained_through_season,
          basis: 'detected: ' + (r.why || 'frequency + proximity') }),
        volatility: M(r.volatility, { n: r.n, confidence: clamp(r.n / 20, 0.3, 1),
          source: 'measured excess residual dispersion in this pairing' }),
        points: M(isNum(r.mean_points) ? r.mean_points : 0, {
          n: r.n, confidence: clamp(r.n / 40, 0.2, 0.8),
          source: 'measured mean residual in this pairing',
          basis: 'history informs SITUATION, never a "Team A always beats Team B" adjustment' })
      };
    },
    /* Section XIII — conference strength, evolving within the season and
       modelled per conference, never as one blanket adjustment. */
    conference: function (st, confName, season) {
      var P = params(); if (!P || !P.conference) return M.missing('conference table not trained');
      var live = st && st.conf ? st.conf[confName] : null;
      if (live && isNum(live.strength)) {
        return M(live.strength, { n: live.n, confidence: clamp(live.n / 30, 0.3, 1),
          source: 'in-season cross-conference results', basis: 'updated live' });
      }
      var tab = P.conference.by_season || {};
      var row = tab[String(season)] && tab[String(season)][confName];
      if (row && isNum(row.strength)) {
        return M(row.strength, { n: row.n, confidence: 0.7,
          source: 'trained conference strength ' + season, basis: 'cross-conference margin' });
      }
      return M.missing('no conference strength for ' + confName + ' in ' + season);
    }
  };

  /* =====================================================================
     LAYER 4 — MATCHUP AND SCHEME
     Team quality does not translate linearly from one opponent to another.
     These are the interactions the spec calls out: pass rush vs OL, run
     game vs run defence, explosive receivers vs deep coverage, mobile QB vs
     edge contain, tempo vs conditioning.
     ===================================================================== */
  var matchup = {
    pairs: function () {
      var P = params();
      return (P && P.matchup && P.matchup.pairs) ? P.matchup.pairs : [];
    },
    /* returns { points: M, detail: [ {name, off, def, z, points} ] } */
    evaluate: function (offProf, defProf, label) {
      var ps = matchup.pairs(), out = [], i, p, o, d, z, contrib, total = 0, used = 0;
      if (!ps.length) return { points: M.missing('matchup weights not trained'), detail: [] };
      for (i = 0; i < ps.length; i++) {
        p = ps[i];
        o = offProf.efficiency[p.off];
        d = defProf.efficiency[p.def];
        if (!avail(o) || !avail(d)) {
          out.push({ name: p.name, available: false,
            reason: 'needs ' + p.off + ' (offence) and ' + p.def + ' (defence); one is not observed' });
          continue;
        }
        z = o.value * (p.off_sign || 1) + d.value * (p.def_sign || 1);
        contrib = z * p.w;
        total += contrib; used++;
        out.push({ name: p.name, available: true, off: o.value, def: d.value,
          interaction: z, points: contrib, side: label });
      }
      if (!used) return { points: M.missing('no matchup pair had both sides observed'), detail: out };
      return {
        points: M(total, { n: used, confidence: clamp(used / ps.length, 0.2, 1),
          source: 'learned matchup interactions', basis: used + '/' + ps.length + ' interactions observed' }),
        detail: out
      };
    },
    /* Section XI — SCHEME FIT 0-100 for the matchup as a whole. High means
       the two identities produce an unusual (either-way) interaction, not
       that one side is better. */
    schemeFit: function (homeEval, awayEval) {
      var mag = 0, n = 0, i, d;
      var lists = [homeEval.detail || [], awayEval.detail || []];
      for (i = 0; i < lists.length; i++) {
        for (var j = 0; j < lists[i].length; j++) {
          d = lists[i][j];
          if (d.available) { mag += Math.abs(d.points); n++; }
        }
      }
      if (!n) return M.missing('no scheme interaction observable (play-level data absent for a side)');
      var P = params();
      var scale = (P && P.matchup && P.matchup.scheme_fit_scale) || 6;
      return M(clamp(100 * (mag / scale), 0, 100), {
        n: n, confidence: clamp(n / 8, 0.2, 1), source: 'matchup interaction magnitude',
        basis: 'total absolute stylistic interaction across ' + n + ' observed pairings' });
    }
  };

  /* =====================================================================
     LAYER 5 — UNCERTAINTY
     The layer that stops the model lying. Everything the engine could not
     observe shows up HERE, as a wider distribution, never as a made-up
     number in the mean.
     ===================================================================== */
  var uncertainty = {
    /* returns { sigma, index (0-100), drivers:[{name, u, lambda, add}] } */
    volatility: function (ctx) {
      var P = params(); if (!P || !P.volatility) return null;
      var V = P.volatility, lam = V.lambda || {}, base = V.sigma_base || (P.distributions && P.distributions.sigma_margin) || 15;
      var drivers = [], mult = 0, k, u;
      for (k in lam) if (has(lam, k)) {
        u = ctx[k];
        if (!isNum(u)) continue;
        u = clamp(u, 0, 1);
        if (u === 0) continue;
        drivers.push({ name: k, u: u, lambda: lam[k], add: lam[k] * u });
        mult += lam[k] * u;
      }
      var sigma = base * (1 + mult);
      var lo = V.sigma_floor || base * 0.8, hi = V.sigma_ceiling || base * 1.8;
      sigma = clamp(sigma, lo, hi);
      drivers.sort(function (a, b) { return b.add - a.add; });
      var idx = clamp(100 * (sigma - lo) / Math.max(1e-9, hi - lo), 0, 100);
      return { sigma: sigma, sigma_base: base, index: idx, drivers: drivers, mult: mult };
    },
    /* CONFIDENCE is NOT the inverse of volatility. Confidence answers "how
       good is my information?"; volatility answers "how wide is the real
       outcome?". A veteran mismatch in a dome can be high confidence AND
       moderate volatility; a rivalry with two unknown QBs is low confidence
       AND high volatility. Conflating them is the classic modelling lie. */
    confidence: function (measurements) {
      var P = params();
      var w = (P && P.confidence && P.confidence.weights) || null;
      if (!w) return M.missing('confidence weights not trained');
      var num = 0, den = 0, missing = [], k, m;
      for (k in w) if (has(w, k)) {
        m = measurements[k];
        den += w[k];
        if (m && m.available) num += w[k] * clamp(m.confidence, 0, 1);
        else missing.push(k);
      }
      if (!(den > 0)) return M.missing('no confidence inputs');
      return M(clamp(100 * num / den, 0, 100), {
        confidence: 1, source: 'information completeness',
        basis: missing.length ? ('missing: ' + missing.join(', ')) : 'all tracked inputs present' });
    }
  };

  /* =====================================================================
     PRESEASON -> IN-SEASON WEIGHTING (Section XXIV)
     The model must be able to say "our preseason belief was wrong". The
     weight on the prior is a LEARNED CURVE by week, not a hand-set schedule.
     ===================================================================== */
  function priorWeight(week, gamesPlayed) {
    var P = params();
    var curve = (P && P.blend && P.blend.prior_weight_by_week) || null;
    var g = isNum(gamesPlayed) ? gamesPlayed : (isNum(week) ? Math.max(0, week - 1) : 0);
    if (!curve) return { w: null, basis: 'blend curve not trained' };
    var key = String(clamp(Math.round(g), 0, 15));
    var w = curve[key];
    if (!isNum(w)) w = curve[String(15)];
    return { w: w, basis: 'learned prior weight at ' + g + ' games played' };
  }

  /* =====================================================================
     DATA QUALITY GATE (Section XXVII)
     ===================================================================== */
  function dataQuality(req) {
    var P = params();
    var missing = [], warn = [], stale = [];
    if (!P) return { status: 'BLOCKED', missing: ['params'], warnings: [],
      reason: 'EDCfbP4Params not loaded' };
    if (!req || !req.state) missing.push('rating_state');
    if (!req || !req.game) missing.push('game');
    else {
      if (!req.game.home) missing.push('home_team');
      if (!req.game.away) missing.push('away_team');
      if (req.game.home && req.game.away && normKey(req.game.home) === normKey(req.game.away))
        missing.push('distinct_teams');
    }
    if (req && isNum(req.season) && req.season > P.trained_through_season + 1) {
      return { status: 'BLOCKED', missing: ['fresh_params'], warnings: [],
        reason: 'Parameters trained through ' + P.trained_through_season + '; season '
          + req.season + ' is beyond the supported window. Regenerate params '
          + '(football/cfb_p4/research) before projecting.' };
    }
    if (missing.length) return { status: 'INSUFFICIENT_DATA', missing: missing,
      warnings: [], reason: 'required inputs absent' };

    var T = req.teams || {};
    if (!T.home || !T.home.roster) warn.push('home roster not supplied — talent, continuity and youth layers are blind');
    if (!T.away || !T.away.roster) warn.push('away roster not supplied — talent, continuity and youth layers are blind');
    if (!T.home || !T.home.qb) warn.push('home starting QB unknown');
    if (!T.away || !T.away.qb) warn.push('away starting QB unknown');
    if (!req.venue) warn.push('venue geography not supplied — travel, altitude and venue HFA fall back to league means');
    if (!req.weather) warn.push('weather not supplied');
    if (!T.home || T.home.injuries == null) warn.push('home injury report not supplied');
    if (!T.away || T.away.injuries == null) warn.push('away injury report not supplied');

    var now = Date.now();
    var ts = req.timestamps || {};
    var ages = { odds: 6, injuries: 48, weather: 12, roster: 24 * 30 };
    var k, t;
    for (k in ages) if (has(ages, k)) {
      t = ts[k] ? Date.parse(ts[k]) : NaN;
      if (isFinite(t) && (now - t) > ages[k] * 3600e3)
        stale.push(k + ' is ' + Math.round((now - t) / 3600e3) + 'h old');
    }
    return { status: 'OK', missing: [], warnings: warn, stale: stale };
  }

  function fingerprint(obj) {
    var s = JSON.stringify(obj), h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'fp_' + (h >>> 0).toString(36);
  }

  /* =====================================================================
     INJURY (XIX), WEATHER (XX), OFF-FIELD (XVIII)
     All three are CALLER-SUPPLIED. The engine defines the contract, prices
     what it is given, and declares the rest unavailable. It never sources,
     infers or invents any of them.
     ===================================================================== */
  var context = {
    /* injuries = [{player, position, starter, snap_share, severity,
                    status:'out'|'doubtful'|'questionable'|'probable',
                    replacement_quality, source, as_of}] */
    injuryImpact: function (list, side) {
      var P = params();
      var W = (P && P.injury) || null;
      if (list == null) return { points: M.missing('no injury report supplied for ' + side),
        uncertainty: M(1, { confidence: 1, source: 'declared missing',
          basis: 'an unknown injury situation is maximum injury uncertainty, not zero' }), detail: [] };
      if (!W) return { points: M.missing('injury weights not trained'),
        uncertainty: M.missing('injury weights not trained'), detail: [] };
      var posW = W.position_weight || {}, statusW = W.status_weight || {};
      var totalPts = 0, unc = 0, detail = [], i, it, pw, sw, share, repl, c;
      for (i = 0; i < list.length; i++) {
        it = list[i];
        pw = posW[String(it.position || '').toUpperCase()];
        if (!isNum(pw)) { detail.push({ player: it.player, note: 'position not weighted; ignored in the mean, counted in uncertainty' }); unc += 0.1; continue; }
        sw = statusW[String(it.status || '').toLowerCase()];
        if (!isNum(sw)) sw = statusW.questionable != null ? statusW.questionable : 0.5;
        share = isNum(it.snap_share) ? clamp(it.snap_share, 0, 1) : (it.starter ? 0.8 : 0.3);
        repl = isNum(it.replacement_quality) ? clamp(it.replacement_quality, 0, 1) : 0.5;
        c = -pw * sw * share * (1 - repl);
        totalPts += c;
        /* a GAME-TIME DECISION is the most uncertain state there is, and
           that uncertainty is priced separately from the mean effect */
        unc += (sw > 0.15 && sw < 0.85 ? 0.35 : 0.1) * share * (pw / (W.max_position_weight || 7));
        detail.push({ player: it.player, position: it.position, status: it.status,
          snap_share: share, points: c, source: it.source || null, as_of: it.as_of || null });
      }
      return {
        points: M(totalPts, { n: list.length, confidence: 0.6, source: 'supplied injury report',
          basis: 'position importance is nonlinear — a starting QB is not a rotational linebacker' }),
        uncertainty: M(clamp(unc, 0, 1), { confidence: 0.7, source: 'injury status ambiguity' }),
        detail: detail
      };
    },
    /* weather = {temp_f, wind_mph, precip_in, humidity, dome} matched to the
       two teams' identities, never applied as a blanket adjustment */
    weather: function (wx, homeProf, awayProf) {
      var P = params();
      var W = (P && P.weather) || null;
      if (!wx) return { total_points: M.missing('no weather supplied'),
        spread_points: M(0, { confidence: 0.5, source: 'no weather supplied',
          basis: 'weather is not assumed to favour either side without data' }),
        uncertainty: M(0.5, { confidence: 1, source: 'declared missing',
          basis: 'unknown weather widens the total distribution' }), detail: [] };
      if (!W) return { total_points: M.missing('weather coefficients not trained'),
        spread_points: M.missing('weather coefficients not trained'),
        uncertainty: M.missing('weather coefficients not trained'), detail: [] };
      if (wx.dome) return { total_points: M(0, { confidence: 0.95, source: 'indoor venue', basis: 'no weather effect' }),
        spread_points: M(0, { confidence: 0.95, source: 'indoor venue' }),
        uncertainty: M(0, { confidence: 0.95, source: 'indoor venue' }), detail: [{ name: 'dome', note: 'weather neutralised' }] };
      var detail = [], tot = 0, unc = 0;
      var wind = isNum(wx.wind_mph) ? wx.wind_mph : null;
      var temp = isNum(wx.temp_f) ? wx.temp_f : null;
      var precip = isNum(wx.precip_in) ? wx.precip_in : null;
      if (isNum(wind)) {
        var over = Math.max(0, wind - (W.wind_threshold_mph || 10));
        var wEff = (W.total_per_wind_mph || 0) * over;
        /* matched to identity: a heavy-pass offence loses more in a gale */
        var passLean = 0;
        if (avail(homeProf.efficiency.pass_rate) && avail(awayProf.efficiency.pass_rate))
          passLean = (homeProf.efficiency.pass_rate.value + awayProf.efficiency.pass_rate.value);
        wEff *= (1 + (W.wind_pass_interaction || 0) * passLean);
        tot += wEff; unc += over > 0 ? 0.2 : 0;
        detail.push({ name: 'wind', value: wind, total_points: wEff,
          note: over > 0 ? 'above the learned threshold; scaled by both offences’ pass rate' : 'below threshold' });
      }
      if (isNum(temp)) {
        var tEff = (W.total_per_deg_below || 0) * Math.max(0, (W.cold_threshold_f || 40) - temp)
          + (W.total_per_deg_above || 0) * Math.max(0, temp - (W.heat_threshold_f || 85));
        tot += tEff;
        if (tEff !== 0) detail.push({ name: 'temperature', value: temp, total_points: tEff });
      }
      if (isNum(precip) && precip > 0) {
        var pEff = (W.total_per_precip_in || 0) * precip;
        tot += pEff; unc += 0.15;
        detail.push({ name: 'precipitation', value: precip, total_points: pEff,
          note: 'ball security and footing; widens the distribution as well as lowering the total' });
      }
      return {
        total_points: M(tot, { confidence: 0.6, source: wx.source || 'supplied weather',
          as_of: wx.as_of || null, basis: 'matched to both teams’ pass identity, not a blanket adjustment' }),
        spread_points: M(0, { confidence: 0.6, source: wx.source || 'supplied weather',
          basis: 'no side-favouring weather effect survived the walk-forward' }),
        uncertainty: M(clamp(unc, 0, 1), { confidence: 0.7, source: 'weather severity' }),
        detail: detail
      };
    },
    /* Section XVIII — public, sourced signals only. Rumours NEVER become
       numbers. A signal's only mechanical effect is on INFORMATION
       CONFIDENCE and volatility, decayed by age and scaled by source
       reliability. */
    offField: function (signals, side) {
      if (signals == null) return { information_confidence: M.missing('no off-field signal feed supplied for ' + side),
        volatility: M(0, { confidence: 0.5, source: 'no feed', basis: 'absence of reports is not evidence of calm' }), detail: [] };
      var P = params();
      var D = (P && P.offfield) || { half_life_days: 21 };
      var now = Date.now(), acc = 0, minConf = 1, detail = [], i, s, age, decay, rel, sev;
      for (i = 0; i < signals.length; i++) {
        s = signals[i];
        rel = isNum(s.source_reliability) ? clamp(s.source_reliability, 0, 1) : 0.3;
        sev = isNum(s.severity) ? clamp(s.severity, 0, 1) : 0.3;
        age = s.date ? (now - Date.parse(s.date)) / 864e5 : null;
        decay = isNum(age) ? Math.pow(0.5, age / (D.half_life_days || 21)) : 0.5;
        acc += rel * sev * decay;
        minConf = Math.min(minConf, rel);
        detail.push({ headline: s.headline || null, severity: sev, reliability: rel,
          age_days: isNum(age) ? Math.round(age) : null, decayed_weight: rel * sev * decay,
          source: s.source || null,
          note: 'affects information confidence and volatility ONLY — never the projected margin' });
      }
      return {
        information_confidence: M(clamp(1 - acc, 0, 1), { n: signals.length, confidence: 0.5,
          source: 'supplied public reporting', basis: 'reliability x severity x time decay' }),
        volatility: M(clamp(acc, 0, 1), { n: signals.length, confidence: 0.5, source: 'supplied public reporting' }),
        detail: detail
      };
    }
  };

  /* =====================================================================
     MARKET (Section XXV)
     The model number is produced FIRST and independently. The market is a
     benchmark. A blend may be reported, but it never overwrites the
     independent projection.
     ===================================================================== */
  var market = {
    /* median of per-book de-vigged fair probabilities for a two-way market */
    consensus: function (books) {
      var fa = [], i, p;
      for (i = 0; i < (books || []).length; i++) {
        p = odds.devigTwoWay(books[i][0], books[i][1]);
        if (p) fa.push(p[0]);
      }
      if (!fa.length) return null;
      fa.sort(function (a, b) { return a - b; });
      var mid = fa.length >> 1;
      var m = (fa.length % 2) ? fa[mid] : (fa[mid - 1] + fa[mid]) / 2;
      return [m, 1 - m];
    },
    gap: function (modelNumber, marketNumber) {
      return (isNum(modelNumber) && isNum(marketNumber)) ? modelNumber - marketNumber : null;
    },
    blend: function (modelNumber, marketNumber, kind) {
      var P = params();
      var w = P && P.blend && P.blend[kind === 'total' ? 'market_total' : 'market_spread'];
      if (!w || !isNum(modelNumber) || !isNum(marketNumber)) return null;
      return w[0] * modelNumber + w[1] * marketNumber + w[2];
    },
    /* The tier ceiling is set by the SHIPPED validation record, not by
       optimism in this function. If a future retrain validates a stronger
       claim, params changes — this code does not. */
    classifyEdge: function (kind, gapPts, confidence) {
      var P = params();
      var V = P && P.validation_summary;
      var out = { recommendation: 'PASS', validated: false, gap: gapPts,
        historical: null, ceiling: 'RESEARCH_LEAN',
        basis: V && V.market ? V.market.headline : 'no validation record loaded' };
      if (!isNum(gapPts)) { out.recommendation = 'NO_MARKET'; return out; }
      var tab = V && V.market && (kind === 'total' ? V.market.ou_vs_close : V.market.ats_vs_close);
      if (tab) {
        var best = null, k, t;
        for (k in tab) if (has(tab, k)) {
          t = parseFloat(k);
          if (Math.abs(gapPts) >= t && (best === null || t > best)) best = t;
        }
        if (best !== null) out.historical = tab[String(best)];
      }
      var ceiling = (V && V.market && V.market.max_tier) || 'RESEARCH_LEAN';
      out.ceiling = ceiling;
      out.validated = !!(V && V.market && V.market.beats_closing_line);
      var minGap = (P && P.market && P.market.min_research_gap) || 2;
      if (Math.abs(gapPts) >= minGap) {
        /* a gap the model itself has low confidence in is not a lean */
        out.recommendation = (isNum(confidence) && confidence < ((P && P.market && P.market.min_confidence) || 35))
          ? 'PASS_LOW_CONFIDENCE' : ceiling;
      }
      return out;
    }
  };

  /* =====================================================================
     QUARTERBACK (Section VIII)
     The QB gets disproportionate attention because he deserves it, and a
     young elite QB and an experienced average QB do NOT get the same
     uncertainty profile even when they get the same mean.
     ===================================================================== */
  var qbEngine = {
    /* q = {player, starts, career_epa_per_db, season_epa_per_db, sack_rate,
            int_rate, rush_value, new_system, returning_starter, attempts,
            source, as_of} */
    evaluate: function (q, side) {
      var P = params();
      var W = (P && P.qb) || null;
      if (!q) return {
        value: M.missing('starting QB not supplied for ' + side),
        stability: M(0, { confidence: 1, source: 'declared missing',
          basis: 'an unknown starter is minimum QB stability, not average' }),
        ceiling: M.missing('starting QB not supplied'),
        floor: M.missing('starting QB not supplied'),
        uncertainty: M(1, { confidence: 1, source: 'declared missing' })
      };
      if (!W) return { value: M.missing('QB weights not trained'),
        stability: M.missing('QB weights not trained'), ceiling: M.missing('QB weights not trained'),
        floor: M.missing('QB weights not trained'), uncertainty: M.missing('QB weights not trained') };

      var att = isNum(q.attempts) ? q.attempts : 0;
      var shrink = W.shrink_attempts || 250;
      var w = att / (att + shrink);
      var eff = isNum(q.season_epa_per_db) ? q.season_epa_per_db
        : (isNum(q.career_epa_per_db) ? q.career_epa_per_db : null);
      var valPts = null;
      if (isNum(eff)) {
        var shrunk = w * eff + (1 - w) * (W.prior_epa_per_db || 0);
        valPts = (W.points_per_epa_db || 0) * shrunk
          + (isNum(q.rush_value) ? (W.points_per_rush_value || 0) * q.rush_value : 0);
      }
      var starts = isNum(q.starts) ? q.starts : null;
      var stab = null;
      if (isNum(starts)) {
        stab = 100 * clamp(starts / (W.starts_for_full_stability || 20), 0, 1);
        if (q.new_system) stab *= (1 - (W.new_system_stability_penalty || 0.25));
        if (q.returning_starter === false) stab *= (1 - (W.not_returning_penalty || 0.2));
      }
      var unc = 1;
      if (isNum(stab)) unc = clamp(1 - stab / 100, 0, 1);
      var spread = isNum(W.ceiling_floor_spread) ? W.ceiling_floor_spread : 6;
      return {
        value: isNum(valPts) ? M(valPts, { n: att, confidence: clamp(w, 0.15, 0.95),
          source: q.source || 'supplied QB record', as_of: q.as_of || null,
          basis: att + ' career dropbacks, shrunk toward the replacement prior' })
          : M.missing('no efficiency history for ' + (q.player || 'this QB')),
        stability: isNum(stab) ? M(stab, { n: starts, confidence: 0.8,
          source: 'career starts' + (q.new_system ? ' (discounted: new system)' : ''),
          basis: starts + ' career starts' }) : M.missing('career starts unknown'),
        ceiling: isNum(valPts) ? M(valPts + spread * (1 - unc * 0.5), { confidence: 0.4,
          source: 'QB distribution', basis: 'upper band widens with inexperience' }) : M.missing('no QB baseline'),
        floor: isNum(valPts) ? M(valPts - spread * (0.5 + unc), { confidence: 0.4,
          source: 'QB distribution', basis: 'lower band widens sharply with inexperience' }) : M.missing('no QB baseline'),
        uncertainty: M(unc, { confidence: 0.8, source: 'QB experience and system continuity' })
      };
    }
  };

  /* =====================================================================
     OFFENSIVE LINE (Section IX)
     A first-class variable, not a rounding error. A talented but
     inexperienced line gets a WIDER distribution, not a lower mean.
     ===================================================================== */
  var olEngine = {
    evaluate: function (prof, effProf, side) {
      var g = prof && prof.by_group ? prof.by_group.OL : null;
      var out = {
        continuity: (g && avail(g.continuity)) ? g.continuity
          : M.missing('no OL continuity observable for ' + side + ' (needs consecutive rosters)'),
        talent: (g && avail(g.talent)) ? g.talent : M.missing('no OL talent measure for ' + side),
        experience: (g && avail(g.experience)) ? g.experience : M.missing('no OL class mix for ' + side),
        pressure_allowed: (effProf && avail(effProf.efficiency.sack_rate_allowed))
          ? effProf.efficiency.sack_rate_allowed
          : M.missing('no sack-rate-allowed observed for ' + side),
        uncertainty: null
      };
      var u = 0.6, known = 0;
      if (avail(out.continuity)) { u = 1 - clamp(out.continuity.value, 0, 1); known++; }
      if (avail(out.experience)) { u = (u + (1 - clamp(out.experience.value, 0, 1))) / 2; known++; }
      out.uncertainty = M(clamp(u, 0, 1), {
        confidence: known ? 0.7 : 0.3,
        source: known ? 'OL continuity and class mix' : 'declared missing',
        basis: known ? 'inexperienced lines are wider, not worse'
          : 'no OL data supplied — treated as elevated uncertainty rather than assumed continuity' });
      return out;
    }
  };

  /* =====================================================================
     PROJECTION (Sections XXII, XXV, XXVI)
     ===================================================================== */
  function sideBundle(st, req, which) {
    var g = req.game, T = req.teams || {};
    var side = T[which] || {};
    var key = normKey(which === 'home' ? g.home : g.away);
    var isFbs = (which === 'home' ? g.home_fbs : g.away_fbs) !== false;
    var prof = strength.profile(st, key, isFbs);
    var roster = talent.profile(side.roster, which);
    var blended = strength.blendedRating(st, key, isFbs, req.week);
    return {
      which: which, key: key, name: (which === 'home' ? g.home : g.away), is_fbs: isFbs,
      strength: prof, blended: blended, talent: roster,
      stability: talent.stability(roster, { coaching: side.coaching }),
      youth: talent.youthVolatility(roster),
      qb: qbEngine.evaluate(side.qb, which),
      ol: olEngine.evaluate(roster, prof, which),
      injuries: context.injuryImpact(side.injuries, which),
      offfield: context.offField(side.news, which),
      schedule: situation.scheduleStress(side.schedule),
      conference: situation.conference(st, side.conference, req.season),
      supplied: side
    };
  }

  function volatilityContext(H, A, rivalry, weatherBundle, travelBundle, req) {
    function pick(a, b, fallback) {
      var xs = [];
      if (isNum(a)) xs.push(a);
      if (isNum(b)) xs.push(b);
      if (!xs.length) return fallback;
      return Math.max.apply(null, xs);
    }
    var qbU = pick(H.qb.uncertainty.available ? H.qb.uncertainty.value : null,
                   A.qb.uncertainty.available ? A.qb.uncertainty.value : null, 1);
    var youth = pick(H.youth.available ? H.youth.value / 100 : null,
                     A.youth.available ? A.youth.value / 100 : null, null);
    var turn = pick(H.stability.available ? 1 - H.stability.value / 100 : null,
                    A.stability.available ? 1 - A.stability.value / 100 : null, null);
    var olU = pick(H.ol.uncertainty.available ? H.ol.uncertainty.value : null,
                   A.ol.uncertainty.available ? A.ol.uncertainty.value : null, null);
    var injU = pick(H.injuries.uncertainty.available ? H.injuries.uncertainty.value : null,
                    A.injuries.uncertainty.available ? A.injuries.uncertainty.value : null, null);
    var newsU = pick(H.offfield.volatility.available ? H.offfield.volatility.value : null,
                     A.offfield.volatility.available ? A.offfield.volatility.value : null, 0);
    var early = null;
    var gp = Math.min(H.blended.games_played == null ? 99 : H.blended.games_played,
                      A.blended.games_played == null ? 99 : A.blended.games_played);
    if (isNum(gp)) early = clamp((5 - gp) / 5, 0, 1);
    var travelU = (travelBundle && avail(travelBundle.miles))
      ? clamp(travelBundle.miles.value / 2500, 0, 1) : 0.3;
    var wxU = weatherBundle && avail(weatherBundle.uncertainty) ? weatherBundle.uncertainty.value : 0.5;
    var ctx = {
      qb_uncertainty: qbU,
      youth_volatility: youth == null ? 0.6 : youth,
      roster_turnover: turn == null ? 0.6 : turn,
      ol_uncertainty: olU == null ? 0.6 : olU,
      injury_uncertainty: injU == null ? 1 : injU,
      offfield_signal: newsU,
      rivalry: (rivalry && avail(rivalry.volatility)) ? clamp(rivalry.volatility.value, 0, 1) : 0,
      weather_uncertainty: wxU,
      travel: travelU,
      early_season: early == null ? 0 : early,
      coaching_change_unknown: (H.supplied.coaching && A.supplied.coaching) ? 0 : 1,
      information_missing: 0
    };
    /* the meta-driver: how much of the model's own input contract was empty */
    var miss = 0, tot = 0, k;
    var probes = [H.talent.overall, A.talent.overall, H.qb.value, A.qb.value,
      H.ol.continuity, A.ol.continuity, H.injuries.points, A.injuries.points,
      H.schedule, A.schedule];
    for (k = 0; k < probes.length; k++) { tot++; if (!avail(probes[k])) miss++; }
    ctx.information_missing = tot ? miss / tot : 1;
    return ctx;
  }

  function projectGame(req) {
    var P = params();
    var nowIso = new Date().toISOString();
    var q = dataQuality(req || {});
    if (q.status !== 'OK') {
      return { status: q.status, reason: q.reason, missing: q.missing,
        warnings: q.warnings || [], model_version: P ? P.model_version : null,
        prediction_timestamp: nowIso };
    }
    var st = req.state, g = req.game;
    var H = sideBundle(st, req, 'home'), A = sideBundle(st, req, 'away');

    /* ---------- Layer 3: venue, travel, rivalry ---------- */
    var neutral = !!g.neutral_site;
    var venue = req.venue || {};
    var hfa = situation.venueHfa(
      g.venue_id != null ? g.venue_id : (venue.home && venue.home.venue_id), neutral, H.key);
    var travel = situation.travel(venue.home, venue.away, neutral);
    var riv = situation.rivalry(H.key, A.key);

    /* ---------- Layer 1: the football number ---------- */
    var ratingGap = M(H.blended.value - A.blended.value, {
      n: Math.min(H.strength.games, A.strength.games),
      confidence: clamp(Math.min(H.strength.games, A.strength.games)
        / ((P.rating.games_for_full_confidence) || 6), 0.15, 1),
      source: 'opponent-adjusted rating',
      basis: 'preseason prior weighted ' + Math.round(100 * H.blended.prior_weight) + '% at '
        + (H.blended.games_played == null ? '?' : H.blended.games_played) + ' games played' });

    /* ---------- Layer 4: matchup ---------- */
    var mHome = matchup.evaluate(H.strength, A.strength, 'home offence vs away defence');
    var mAway = matchup.evaluate(A.strength, H.strength, 'away offence vs home defence');
    var matchupPts = (avail(mHome.points) || avail(mAway.points))
      ? M(pts(mHome.points) - pts(mAway.points), {
          confidence: Math.min(mHome.points.confidence || 0, mAway.points.confidence || 0) || 0.2,
          source: 'learned matchup interactions',
          basis: 'home stylistic edge minus away stylistic edge' })
      : M.missing('no matchup interaction observable (play-level efficiency absent for a side)');
    var schemeFit = matchup.schemeFit(mHome, mAway);

    /* ---------- QB, injury, schedule, weather ---------- */
    var qbGap = (avail(H.qb.value) || avail(A.qb.value))
      ? M(pts(H.qb.value) - pts(A.qb.value), {
          confidence: Math.min(H.qb.value.confidence || 0, A.qb.value.confidence || 0) || 0.2,
          source: 'QB layer',
          basis: (avail(H.qb.value) && avail(A.qb.value)) ? 'both starters known'
            : 'only one starter known — the unknown side contributes 0 to the mean and raises volatility' })
      : M.missing('neither starting QB supplied');
    var injGap = (avail(H.injuries.points) || avail(A.injuries.points))
      ? M(pts(H.injuries.points) - pts(A.injuries.points), {
          confidence: 0.6, source: 'supplied injury reports' })
      : M.missing('no injury report supplied for either side');
    var schedGap = (avail(H.schedule) || avail(A.schedule))
      ? M(((P.schedule && P.schedule.points_per_stress) || 0)
          * ((avail(A.schedule) ? A.schedule.value : 0) - (avail(H.schedule) ? H.schedule.value : 0)) / 100, {
          confidence: 0.4, source: 'schedule stress differential' })
      : M.missing('no schedule context supplied');
    var wx = context.weather(req.weather, H.strength, A.strength);

    var confGap = (avail(H.conference) && avail(A.conference) && H.supplied.conference !== A.supplied.conference)
      ? M(((P.conference && P.conference.points_per_strength) || 0)
          * (H.conference.value - A.conference.value)
          * clamp(1 - Math.min(H.strength.games, A.strength.games) / 6, 0, 1), {
          confidence: 0.4, source: 'conference strength differential',
          basis: 'only material while in-season samples are thin; decays to 0 by six games' })
      : M(0, { confidence: 0.6, source: 'same conference or no conference table',
          basis: 'no cross-conference adjustment applies' });

    /* ---------- the mean: ONLY available terms move it ---------- */
    var terms = [
      { key: 'rating', label: 'opponent-adjusted team rating', m: ratingGap },
      { key: 'hfa', label: 'venue home-field advantage', m: hfa },
      { key: 'qb', label: 'quarterback', m: qbGap },
      { key: 'matchup', label: 'stylistic matchup', m: matchupPts },
      { key: 'travel', label: 'travel burden', m: travel.points },
      { key: 'schedule', label: 'schedule stress', m: schedGap },
      { key: 'injury', label: 'injuries', m: injGap },
      { key: 'rivalry', label: 'rivalry situational effect', m: riv.points },
      { key: 'conference', label: 'conference strength', m: confGap }
    ];
    var fairSpread = 0, i;
    for (i = 0; i < terms.length; i++) fairSpread += pts(terms[i].m);

    /* ---------- total ---------- */
    var scoringBase = strength.predictScoring(st, H.key, A.key);
    var fairTotal = null, totalTerms = [];
    if (isNum(scoringBase)) {
      fairTotal = scoringBase + pts(wx.total_points);
      totalTerms.push({ key: 'scoring', label: 'opponent-adjusted scoring profile',
        m: M(scoringBase, { confidence: 0.6, source: 'scoring EWMAs vs league mean' }) });
      totalTerms.push({ key: 'weather', label: 'weather', m: wx.total_points });
      if (avail(H.strength.efficiency.plays_per_game) && avail(A.strength.efficiency.plays_per_game)) {
        var paceAdj = ((P.total && P.total.points_per_pace) || 0)
          * (H.strength.efficiency.plays_per_game.value + A.strength.efficiency.plays_per_game.value);
        fairTotal += paceAdj;
        totalTerms.push({ key: 'pace', label: 'tempo', m: M(paceAdj, { confidence: 0.5, source: 'opponent-adjusted pace' }) });
      }
    }

    /* ---------- Layer 5 ---------- */
    var volCtx = volatilityContext(H, A, riv, wx, travel, req);
    var vol = uncertainty.volatility(volCtx);
    var sigma = vol ? vol.sigma : (P.distributions && P.distributions.sigma_margin) || 15;
    var sigmaBase = vol ? vol.sigma_base : sigma;

    var confMeasure = uncertainty.confidence({
      rating: ratingGap, qb: qbGap, roster_home: H.talent.overall, roster_away: A.talent.overall,
      matchup: matchupPts, venue: hfa, travel: travel.points, injuries: injGap,
      schedule: schedGap, weather: wx.total_points, offfield_home: H.offfield.information_confidence,
      offfield_away: A.offfield.information_confidence
    });

    var pHome = dist.winProb(fairSpread, sigma);
    var marginDist = dist.marginDistribution(fairSpread, sigma);

    /* ---------- market ---------- */
    var mkt = req.market || {};
    var gapS = market.gap(fairSpread, mkt.spread_line);
    var gapT = market.gap(fairTotal, mkt.total_line);
    var consensus = mkt.quotes_h2h ? market.consensus(mkt.quotes_h2h) : null;
    var cover = isNum(mkt.spread_line)
      ? dist.coverProbSpread(fairSpread, mkt.spread_line, sigma, sigmaBase) : null;
    var over = (isNum(mkt.total_line) && isNum(fairTotal))
      ? dist.coverProbTotal(fairTotal, mkt.total_line, 'over') : null;
    var confPct = avail(confMeasure) ? confMeasure.value : null;

    var out = {
      status: 'PREDICTED',
      engine: ENGINE_ID,
      game: { home: g.home, away: g.away, home_key: H.key, away_key: A.key,
        season: req.season || null, week: req.week || null,
        neutral_site: neutral, venue_id: g.venue_id != null ? g.venue_id : null,
        kickoff: g.kickoff || null,
        home_conference: H.supplied.conference || null, away_conference: A.supplied.conference || null },
      model: {
        fair_spread: fairSpread,                 /* home perspective, + = home favoured by */
        fair_total: fairTotal,
        home_win_prob: pHome,
        away_win_prob: pHome == null ? null : 1 - pHome,
        fair_home_ml: pHome ? odds.decToAm(1 / pHome) : null,
        fair_away_ml: pHome ? odds.decToAm(1 / (1 - pHome)) : null,
        sigma_margin: sigma,
        expected_margin: fairSpread,
        median_margin: marginDist ? dist.quantile(marginDist, 0.5) : null,
        p10_margin: marginDist ? dist.quantile(marginDist, 0.10) : null,
        p90_margin: marginDist ? dist.quantile(marginDist, 0.90) : null,
        blend_spread: market.blend(fairSpread, mkt.spread_line, 'spread'),
        blend_total: market.blend(fairTotal, mkt.total_line, 'total')
      },
      scores: {
        confidence: confPct,
        volatility: vol ? vol.index : null,
        roster_stability: (avail(H.stability) && avail(A.stability))
          ? (H.stability.value + A.stability.value) / 2
          : (avail(H.stability) ? H.stability.value : (avail(A.stability) ? A.stability.value : null)),
        roster_stability_home: avail(H.stability) ? H.stability.value : null,
        roster_stability_away: avail(A.stability) ? A.stability.value : null,
        qb_stability_home: avail(H.qb.stability) ? H.qb.stability.value : null,
        qb_stability_away: avail(A.qb.stability) ? A.qb.stability.value : null,
        injury_uncertainty: Math.round(100 * Math.max(
          avail(H.injuries.uncertainty) ? H.injuries.uncertainty.value : 1,
          avail(A.injuries.uncertainty) ? A.injuries.uncertainty.value : 1)),
        rivalry_intensity: avail(riv.intensity) ? Math.round(100 * clamp(riv.intensity.value, 0, 1)) : null,
        scheme_fit: avail(schemeFit) ? schemeFit.value : null,
        schedule_stress_home: avail(H.schedule) ? H.schedule.value : null,
        schedule_stress_away: avail(A.schedule) ? A.schedule.value : null,
        youth_volatility_home: avail(H.youth) ? H.youth.value : null,
        youth_volatility_away: avail(A.youth) ? A.youth.value : null
      },
      layers: {
        strength: { home: H.strength, away: A.strength,
          preseason_blend: { prior_weight: H.blended.prior_weight,
            home_carried: H.blended.carried, home_this_season: H.blended.this_season,
            away_carried: A.blended.carried, away_this_season: A.blended.this_season,
            games_played: H.blended.games_played, basis: H.blended.basis,
            preseason_share: (function () {
              var c = P.blend && P.blend.preseason_share_by_games;
              if (!c || H.blended.games_played == null) return null;
              return c[String(clamp(Math.round(H.blended.games_played), 0, 15))];
            })() } },
        talent: { home: H.talent, away: A.talent },
        situation: { venue_hfa: hfa, travel: travel, rivalry: riv,
          schedule_home: H.schedule, schedule_away: A.schedule,
          conference_home: H.conference, conference_away: A.conference, weather: wx },
        matchup: { home_offence: mHome, away_offence: mAway, scheme_fit: schemeFit },
        uncertainty: { sigma: sigma, sigma_base: sigmaBase, index: vol ? vol.index : null,
          drivers: vol ? vol.drivers : [], context: volCtx, confidence: confMeasure },
        qb: { home: H.qb, away: A.qb },
        offensive_line: { home: H.ol, away: A.ol },
        injuries: { home: H.injuries, away: A.injuries },
        off_field: { home: H.offfield, away: A.offfield }
      },
      contributions: terms.map(function (t) {
        return { key: t.key, label: t.label, points: pts(t.m),
          available: avail(t.m), confidence: t.m.confidence,
          source: t.m.source, basis: t.m.basis, reason: t.m.reason };
      }),
      total_contributions: totalTerms.map(function (t) {
        return { key: t.key, label: t.label, points: pts(t.m), available: avail(t.m),
          source: t.m.source, reason: t.m.reason };
      }),
      market: {
        spread_line: isNum(mkt.spread_line) ? mkt.spread_line : null,
        total_line: isNum(mkt.total_line) ? mkt.total_line : null,
        opening_spread: isNum(mkt.opening_spread) ? mkt.opening_spread : null,
        opening_total: isNum(mkt.opening_total) ? mkt.opening_total : null,
        line_move: (isNum(mkt.spread_line) && isNum(mkt.opening_spread))
          ? mkt.spread_line - mkt.opening_spread : null,
        consensus_fair_home: consensus ? consensus[0] : null,
        spread_gap: gapS, total_gap: gapT,
        book: mkt.book || null, as_of: mkt.as_of || null
      },
      edge: {
        spread: market.classifyEdge('spread', gapS, confPct),
        total: market.classifyEdge('total', gapT, confPct)
      },
      cover: cover,
      over: over,
      data_quality: q,
      unproven: !(P.validation_summary && P.validation_summary.market
        && P.validation_summary.market.beats_closing_line),
      model_version: P.model_version,
      feature_version: P.feature_version,
      trained_through_season: P.trained_through_season,
      prediction_timestamp: nowIso,
      timestamps: req.timestamps || {},
      fingerprint: fingerprint({ h: H.key, a: A.key, s: req.season, w: req.week,
        v: P.model_version, f: P.feature_version,
        m: [mkt.spread_line, mkt.total_line], o: (req.timestamps && req.timestamps.odds) || null })
    };

    /* ---- sanity: fail loudly rather than publish nonsense ---- */
    if (!isNum(fairSpread) || Math.abs(fairSpread) > 70
      || (pHome !== null && !(pHome > 0 && pHome < 1))
      || (isNum(fairTotal) && (fairTotal < 10 || fairTotal > 130))
      || !(sigma > 3 && sigma < 40)) {
      return { status: 'BLOCKED', reason: 'sanity check failed',
        debug: { fair_spread: fairSpread, fair_total: fairTotal, p_home: pHome, sigma: sigma },
        model_version: P.model_version, prediction_timestamp: nowIso };
    }
    out.explanation = explain(out);
    return out;
  }

  /* =====================================================================
     EXPLANATION ENGINE (Section XXVIII)
     Football language, not latent-variable language. Every sentence is
     generated from a real measurement with its real magnitude.
     ===================================================================== */
  function fmtPts(x) { return (x > 0 ? '+' : '') + x.toFixed(1); }

  function explain(o) {
    var L = o.layers, drivers = [], counters = [], unknown = [], quality = [];
    var home = o.game.home, away = o.game.away;
    var i, c, d;

    /* ---- primary drivers: the biggest AVAILABLE contributions ---- */
    var sorted = o.contributions.slice().filter(function (x) { return x.available && Math.abs(x.points) > 0.05; });
    sorted.sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); });
    for (i = 0; i < sorted.length && drivers.length < 5; i++) {
      c = sorted[i];
      var favours = c.points > 0 ? home : away;
      var txt;
      if (c.key === 'rating') {
        var share = preseasonShare(L.strength.preseason_blend.games_played);
        txt = favours + ' is the better football team by ' + Math.abs(c.points).toFixed(1)
          + ' points on opponent-adjusted results'
          + (share == null ? ''
            : share > 0.5
              ? ' — but about ' + Math.round(100 * share) + '% of that rating is still last '
                + 'season carried forward, and in a portal era last season is a different team'
              : share > 0.2
                ? ', with roughly ' + Math.round(100 * share) + '% of it still inherited from last season'
                : ', and it is now built almost entirely on what these teams have done THIS season');
      } else if (c.key === 'hfa') {
        var perVenue = /venue history/.test(L.situation.venue_hfa.source || '');
        txt = 'Playing at ' + home + ' is worth ' + Math.abs(c.points).toFixed(1) + ' points'
          + (perVenue
            ? ' at this specific venue (' + L.situation.venue_hfa.n + ' rated home games)'
            : ' — the league-wide home-field number, because a per-venue table was tested '
              + 'and could not be told apart from the home team\u2019s own quality');
      } else if (c.key === 'qb') {
        txt = 'The quarterback matchup favours ' + favours + ' by ' + Math.abs(c.points).toFixed(1)
          + ' points' + (c.basis ? ' (' + c.basis + ')' : '');
      } else if (c.key === 'matchup') {
        txt = 'Stylistically the matchup favours ' + favours + ' by ' + Math.abs(c.points).toFixed(1)
          + ' points: ' + topInteraction(L.matchup, c.points > 0);
      } else if (c.key === 'travel') {
        txt = away + ' travels ' + (L.situation.travel.miles.available
          ? Math.round(L.situation.travel.miles.value) + ' miles' : 'a long way')
          + (L.situation.travel.tz_delta.available && Math.abs(L.situation.travel.tz_delta.value) >= 1
            ? ' across ' + Math.abs(L.situation.travel.tz_delta.value) + ' time zones' : '')
          + ', worth ' + Math.abs(c.points).toFixed(1) + ' points to ' + favours;
      } else if (c.key === 'schedule') {
        txt = 'Schedule stress differs: ' + favours + ' arrives in better shape, worth '
          + Math.abs(c.points).toFixed(1) + ' points';
      } else if (c.key === 'injury') {
        txt = 'The reported injuries favour ' + favours + ' by ' + Math.abs(c.points).toFixed(1) + ' points';
      } else if (c.key === 'rivalry') {
        txt = 'This pairing behaves like a rivalry; its measured situational effect is '
          + fmtPts(c.points) + ' points toward ' + home
          + ' — history informs the SITUATION, it never asserts that one side simply beats the other';
      } else if (c.key === 'conference') {
        txt = 'Conference strength differs and the in-season sample is still thin, worth '
          + Math.abs(c.points).toFixed(1) + ' points to ' + favours;
      } else {
        txt = c.label + ' contributes ' + fmtPts(c.points) + ' points';
      }
      drivers.push({ key: c.key, points: c.points, text: txt, source: c.source });
    }

    /* ---- counterarguments: why this number could be wrong ---- */
    /* a driver the fit gave zero weight widens nothing, and listing it as a
       reason the model could be wrong would be theatre */
    var vd = (L.uncertainty.drivers || []).filter(function (x) { return x.add > 0.005; }).slice(0, 6);
    for (i = 0; i < vd.length && counters.length < 3; i++) {
      d = vd[i];
      var name = d.name.replace(/_/g, ' ');
      var pctWider = Math.round(100 * d.add);
      var why;
      if (d.name === 'qb_uncertainty') why = 'the quarterback situation is not settled or not known, which is the single widest source of college variance';
      else if (d.name === 'information_missing') why = 'a large share of the model’s own input contract was empty for this game';
      else if (d.name === 'roster_turnover') why = 'one of these rosters turned over heavily, so last season’s identity may not be this season’s';
      else if (d.name === 'youth_volatility') why = 'these teams lean young, and young teams are less predictable rather than simply worse';
      else if (d.name === 'rivalry') why = 'rivalry games in this pairing have historically produced wider residuals than their ratings imply';
      else if (d.name === 'injury_uncertainty') why = 'availability is unresolved or unreported';
      else if (d.name === 'ol_uncertainty') why = 'an offensive line with unclear continuity can swing a game in either direction';
      else if (d.name === 'early_season') why = 'it is early enough that both ratings still lean on preseason belief';
      else if (d.name === 'weather_uncertainty') why = 'the weather at kickoff is not known';
      else if (d.name === 'coaching_change_unknown') why = 'coordinator and staff continuity was not supplied, and a scheme change is invisible to the ratings';
      else why = name + ' is elevated';
      counters.push({ key: d.name, widening_pct: pctWider,
        text: 'The projection could be wrong because ' + why + ' — it widens the outcome range by about '
          + pctWider + '%.' });
    }
    if (counters.length < 3 && L.uncertainty.context
        && L.uncertainty.context.information_missing > 0.4) {
      counters.push({ key: 'information_missing', widening_pct: null,
        text: 'The projection could be wrong because '
          + Math.round(100 * L.uncertainty.context.information_missing)
          + '% of the model’s own input contract was empty for this game — no roster, '
          + 'starter, injury or schedule context reached it, so the number is a team-strength '
          + 'read and little more.' });
    }
    if (counters.length < 3 && o.market.spread_gap != null && Math.abs(o.market.spread_gap) >= 3) {
      counters.push({ key: 'market_disagreement', widening_pct: null,
        text: 'The market disagrees by ' + Math.abs(o.market.spread_gap).toFixed(1)
          + ' points. The market is not the truth, but a gap that large is more often the model missing '
          + 'information (a suspension, a starter, a scheme change) than the market being wrong.' });
    }
    if (counters.length < 3) {
      counters.push({ key: 'sample', widening_pct: null,
        text: 'College ratings are built on twelve-game seasons against wildly uneven schedules; '
          + 'even a clean rating gap carries more estimation error than the number implies.' });
    }

    /* ---- unpredictable / unquantified ---- */
    function unk(label, why) { unknown.push({ item: label, why: why }); }
    if (!avail(L.qb.home.value)) unk('Home starting quarterback', L.qb.home.value.reason);
    if (!avail(L.qb.away.value)) unk('Away starting quarterback', L.qb.away.value.reason);
    if (!avail(L.injuries.home.points)) unk('Home availability / injuries', L.injuries.home.points.reason);
    if (!avail(L.injuries.away.points)) unk('Away availability / injuries', L.injuries.away.points.reason);
    if (!avail(L.talent.home.blue_chip)) unk('Blue-chip / per-player recruiting talent', L.talent.home.blue_chip.reason);
    if (!avail(L.situation.weather.total_points)) unk('Weather at kickoff', L.situation.weather.total_points.reason);
    if (!avail(L.off_field.home.information_confidence) || !avail(L.off_field.away.information_confidence))
      unk('Off-field, culture and NIL situation',
        'no public feed for NIL figures, locker-room reporting or discipline exists that this engine reads; '
        + 'nothing is inferred and the gap is carried as uncertainty');
    unk('Coaching and coordinator continuity',
      (o.layers.strength.home.games != null ? '' : '')
      + 'no public coaching-tenure feed is wired; a new coordinator changes a team’s identity in ways the ratings only learn after the fact');
    unk('Motivation, lookahead and locker-room state',
      'not measurable from any public source; treated as variance, never as a point adjustment');

    /* ---- data quality ---- */
    (o.data_quality.warnings || []).forEach(function (w) { quality.push({ level: 'missing', text: w }); });
    (o.data_quality.stale || []).forEach(function (s) { quality.push({ level: 'stale', text: s }); });
    if (o.market.spread_line == null) quality.push({ level: 'missing', text: 'no book spread joined to this game — no edge is claimed' });
    if (o.market.total_line == null) quality.push({ level: 'missing', text: 'no book total joined to this game' });
    var low = o.contributions.filter(function (x) { return x.available && x.confidence != null && x.confidence < 0.35; });
    low.forEach(function (x) {
      quality.push({ level: 'low_confidence', text: x.label + ' is in the number but rests on a thin sample' });
    });

    /* ---- the headline paragraph ---- */
    var lead;
    if (drivers.length) {
      var side = o.model.fair_spread > 0 ? home : away;
      lead = side + ' projects ' + Math.abs(o.model.fair_spread).toFixed(1) + ' points better'
        + (o.game.neutral_site ? ' on a neutral field' : ' at ' + home) + ' primarily because '
        + drivers.slice(0, 2).map(function (x) {
            /* lower-case the lead-in only when it is not a proper noun — a
               sentence that starts with a school name must keep its capital */
            var t = x.text;
            if (t.indexOf(home) === 0 || t.indexOf(away) === 0) return t;
            return t.charAt(0).toLowerCase() + t.slice(1);
          }).join('; and ')
        + '. The model discounts that edge because ' + (counters[0] ? counters[0].text.replace(/^The projection could be wrong because /, '') : 'college football is college football')
        + ' Outcome range p10–p90: ' + (o.model.p10_margin != null ? fmtPts(o.model.p10_margin) : '?')
        + ' to ' + (o.model.p90_margin != null ? fmtPts(o.model.p90_margin) : '?') + '.';
    } else {
      lead = 'The engine could not assemble enough observed inputs to explain this projection in football terms. '
        + 'That is itself the finding: treat the number as weak.';
    }

    return { summary: lead, primary_drivers: drivers, counterarguments: counters,
      unpredictable_variables: unknown, data_quality: quality };
  }

  /* Section XXIV, said out loud: with step size k, a rating that has absorbed
     n games this season still carries (1-k)^n of its August value. */
  function preseasonShare(gamesPlayed) {
    var P = params();
    var curve = P && P.blend && P.blend.preseason_share_by_games;
    if (!curve || !isNum(gamesPlayed)) return null;
    var key = String(clamp(Math.round(gamesPlayed), 0, 15));
    var v = curve[key];
    return isNum(v) ? v : null;
  }

  function topInteraction(mLayer, homeSide) {
    var list = (homeSide ? mLayer.home_offence.detail : mLayer.away_offence.detail) || [];
    var best = null, i;
    for (i = 0; i < list.length; i++) {
      if (!list[i].available) continue;
      if (!best || Math.abs(list[i].points) > Math.abs(best.points)) best = list[i];
    }
    return best ? best.name : 'several small stylistic edges';
  }

  /* =====================================================================
     INGEST — how state is advanced. Chronological order is load-bearing.
     ===================================================================== */
  var ingest = {
    absorbGame: function (state, game) {
      if (!state || !game) return state;
      var g = {
        home: normKey(game.home), away: normKey(game.away),
        home_fbs: game.home_fbs !== false, away_fbs: game.away_fbs !== false,
        neutral: !!game.neutral_site, hfa: game.hfa,
        margin: game.home_points - game.away_points,
        home_points: game.home_points, away_points: game.away_points,
        team_stats: null
      };
      if (game.team_stats) {
        g.team_stats = {};
        g.team_stats[g.home] = game.team_stats.home || null;
        g.team_stats[g.away] = game.team_stats.away || null;
      }
      if (!isNum(g.margin)) return state;
      strength.absorb(state, g);
      return state;
    },
    seasonBreak: function (state) { strength.seasonBreak(state); return state; },
    /* Recruiting star ratings are NOT in the public roster feed this engine
       reads. Supply them here and the blue-chip layer switches on; do not,
       and it stays honestly dark. */
    setRecruiting: function (rosterBundle, players) {
      if (!rosterBundle || !players) return rosterBundle;
      rosterBundle.blue_chip_ratio = players.blue_chip_ratio;
      rosterBundle.source = (rosterBundle.source || '') + ' + caller recruiting';
      return rosterBundle;
    }
  };

  root.EDCfbP4 = {
    version: function () { var P = params(); return P ? P.model_version : null; },
    meta: function () {
      var P = params(); if (!P) return null;
      return { engine: ENGINE_ID, model_version: P.model_version, built_at: P.built_at,
        feature_version: P.feature_version, trained_through: P.trained_through_season,
        provenance: P.data_provenance, validation: P.validation_summary,
        conferences: P.universe ? P.universe.conferences : null };
    },
    newState: function () { return strength.newState(); },
    projectGame: projectGame,
    explain: explain,
    ingest: ingest,
    _internal: { M: M, pts: pts, avail: avail, clamp: clamp, isNum: isNum,
      normKey: normKey, params: params, effFeats: effFeats, priorWeight: priorWeight,
      dataQuality: dataQuality, fingerprint: fingerprint, normCdf: normCdf,
      POS_GROUPS: POS_GROUPS, sideBundle: sideBundle, volatilityContext: volatilityContext },
    odds: odds, dist: dist, strength: strength, talent: talent,
    situation: situation, matchup: matchup, uncertainty: uncertainty,
    context: context, market: market, qb: qbEngine, ol: olEngine,
    normKey: normKey, dataQuality: dataQuality, fingerprint: fingerprint
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.EDCfbP4;
})();

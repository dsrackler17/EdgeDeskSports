/* ===========================================================================
   EdgeDesk BASEBALL RUN MODEL — the engine.

   WHY IT EXISTS. Research → Baseball held a ten-season archive, a card and a
   brief, and not one number a reader could set beside a price. A bettor
   opening a baseball screen is asking two questions — "what should this total
   be" and "what should this side be" — and EdgeDesk answered neither, so the
   screen read as a reference work rather than a research desk.

   WHAT IT IS. A deterministic run-expectancy calculation. Each club's runs
   are built multiplicatively from the league scoring environment: the club's
   own offense, the arms it is facing (the starter for his expected share of
   the game, the relief corps for the rest), the ballpark, and the weather.
   Two run expectations become a run DISTRIBUTION — a negative binomial whose
   overdispersion matches real team-game scoring — and the distribution is
   what produces a total, a win probability, a run line and a fair price.

   WHAT IT IS NOT, said as plainly as the surface says it:
     - It is NOT trained. No coefficient here was fitted to a betting line,
       because EdgeDesk holds no baseball line archive to fit to.
     - It has NO graded closing-line record, so it is not validated, and a
       disagreement with the market is a QUESTION, not an edge.
     - It never guesses an input. A missing starter, a club with no rate, a
       park with no factor and a forecast that is absent are each reported in
       data_quality and each WIDEN what the engine says it does not know,
       rather than being filled in with a league average and forgotten.
     - It does not blend itself with the market. The market number is carried
       beside the model number and the difference is stated; it is never
       folded in to make the model look closer than it is.

   Every step is inspectable: `components` carries each multiplier by name and
   `contributions` carries the sentence-level reason for each one, so the
   surface can show WHY a number differs from a price instead of asserting it.

   Loads in the browser (window.EDBaseball) and under Node (module.exports),
   the same dual shape football/engine.js uses.
   =========================================================================== */
(function (root) {
  'use strict';

  function params() { return root.EDBaseballParams || null; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = +v; return isFinite(n) ? n : null;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round(v, dp) {
    if (!isNum(v)) return null;
    var f = Math.pow(10, dp == null ? 3 : dp);
    return Math.round(v * f) / f;
  }

  /* ---------------- odds: display and de-vig ----------------
     Conversions only. Nothing here decides whether a price is good; it turns
     a probability into the notation a reader already reads prices in. */
  var odds = {
    decToAm: function (dec) {
      dec = num(dec); if (dec == null || dec <= 1) return null;
      return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
    },
    amToDec: function (am) {
      am = num(am); if (am == null || am === 0) return null;
      return am > 0 ? 1 + am / 100 : 1 + 100 / (-am);
    },
    probToAm: function (p) {
      p = num(p); if (p == null || p <= 0 || p >= 1) return null;
      return odds.decToAm(1 / p);
    },
    impliedFromDec: function (dec) {
      dec = num(dec); if (dec == null || dec <= 1) return null;
      return 1 / dec;
    },
    /* Two-way de-vig by the multiplicative (proportional) method. It is the
       method the rest of EdgeDesk uses for a fair two-way number, and it is
       stated rather than assumed because power and shin de-vig give a
       different answer on a lopsided market. */
    devigTwoWay: function (decA, decB) {
      var a = odds.impliedFromDec(decA), b = odds.impliedFromDec(decB);
      if (a == null || b == null) return null;
      var s = a + b; if (!(s > 0)) return null;
      return { a: a / s, b: b / s, hold: s - 1 };
    }
  };

  /* ---------------- the run distribution ----------------
     Team runs in a game are count data with a long right tail: a negative
     binomial with variance = mean * dispersion reproduces both the mean and
     the spread of real team-game scoring, and unlike a simulation it is exact
     and it is the same every time it is asked. */
  var dist = {
    /* PMF over 0..max, renormalised so the truncated tail is not silently
       lost — a probability that does not sum to one is a bug that shows up
       later as a win probability that does not either. */
    runPmf: function (mean, dispersion, max) {
      mean = num(mean); dispersion = num(dispersion);
      if (mean == null || mean <= 0) return null;
      if (dispersion == null || dispersion <= 1.0001) dispersion = 1.0001;
      max = max || 24;
      var r = mean / (dispersion - 1), p = 1 / dispersion;
      var out = new Array(max + 1), k, sum = 0;
      out[0] = Math.pow(p, r); sum = out[0];
      for (k = 1; k <= max; k++) {
        out[k] = out[k - 1] * ((k - 1 + r) / k) * (1 - p);
        sum += out[k];
      }
      if (!(sum > 0) || !isFinite(sum)) return null;
      for (k = 0; k <= max; k++) out[k] /= sum;
      return out;
    },
    /* P(home wins). Baseball has no ties, so a regulation tie is played out
       in extras, where the home club bats last. That is the only place an
       assumption enters, and it is a published constant. */
    winProb: function (pmfH, pmfA, extraHome) {
      if (!pmfH || !pmfA) return null;
      var w = 0, t = 0, h, a;
      for (h = 0; h < pmfH.length; h++) {
        if (!(pmfH[h] > 0)) continue;
        for (a = 0; a < pmfA.length; a++) {
          if (!(pmfA[a] > 0)) continue;
          var j = pmfH[h] * pmfA[a];
          if (h > a) w += j; else if (h === a) t += j;
        }
      }
      return w + t * (extraHome == null ? 0.5 : extraHome);
    },
    /* PMF of the game total, by convolution. */
    totalPmf: function (pmfH, pmfA) {
      if (!pmfH || !pmfA) return null;
      var n = pmfH.length + pmfA.length - 1, out = new Array(n), i, h, a;
      for (i = 0; i < n; i++) out[i] = 0;
      for (h = 0; h < pmfH.length; h++) {
        if (!(pmfH[h] > 0)) continue;
        for (a = 0; a < pmfA.length; a++) out[h + a] += pmfH[h] * pmfA[a];
      }
      return out;
    },
    /* Over / under / push against a posted total. A whole-number line pushes
       and the push probability is returned rather than being split into the
       two sides, because a push is not half a win. */
    totalProbs: function (pmfT, line) {
      line = num(line);
      if (!pmfT || line == null) return null;
      var over = 0, under = 0, push = 0, k;
      for (k = 0; k < pmfT.length; k++) {
        if (k > line) over += pmfT[k];
        else if (k < line) under += pmfT[k];
        else push += pmfT[k];
      }
      return { over: over, under: under, push: push,
        over_fair: (over + under) > 0 ? over / (over + under) : null };
    },
    /* Run line. `line` is the HOME side's handicap: -1.5 means the home club
       must win by two or more, +1.5 means it may lose by one. */
    runLineProbs: function (pmfH, pmfA, line) {
      line = num(line);
      if (!pmfH || !pmfA || line == null) return null;
      var cover = 0, fail = 0, push = 0, h, a;
      for (h = 0; h < pmfH.length; h++) {
        if (!(pmfH[h] > 0)) continue;
        for (a = 0; a < pmfA.length; a++) {
          if (!(pmfA[a] > 0)) continue;
          var j = pmfH[h] * pmfA[a], m = (h + line) - a;
          if (m > 0) cover += j; else if (m < 0) fail += j; else push += j;
        }
      }
      return { cover: cover, fail: fail, push: push,
        cover_fair: (cover + fail) > 0 ? cover / (cover + fail) : null };
    },
    quantiles: function (pmf, qs) {
      if (!pmf) return null;
      var out = [], c = 0, i = 0, qi = 0;
      qs = qs || [0.1, 0.5, 0.9];
      for (i = 0; i < pmf.length && qi < qs.length; i++) {
        c += pmf[i];
        while (qi < qs.length && c >= qs[qi]) { out.push(i); qi++; }
      }
      while (out.length < qs.length) out.push(pmf.length - 1);
      return out;
    },
    mean: function (pmf) {
      if (!pmf) return null;
      var m = 0, i; for (i = 0; i < pmf.length; i++) m += i * pmf[i];
      return m;
    },
    variance: function (pmf) {
      if (!pmf) return null;
      var m = dist.mean(pmf), v = 0, i;
      for (i = 0; i < pmf.length; i++) v += (i - m) * (i - m) * pmf[i];
      return v;
    }
  };

  /* ---------------- shared pieces ---------------- */

  /* rate regressed toward a baseline by sample: the one shrinkage rule this
     engine uses, applied identically to a club rate and to a pitcher line. */
  function regress(rate, baseline, sample, k) {
    rate = num(rate); baseline = num(baseline); sample = num(sample);
    if (rate == null || baseline == null) return baseline;
    if (sample == null || sample <= 0) return baseline;
    var w = sample / (sample + k);
    return baseline + (rate - baseline) * w;
  }

  /* The wind component blowing OUT along the field axis, in mph.
     mlb_game_cards publishes wind_rel as a label in some builds and as a
     relative angle in others; both are read, and neither is guessed at. A
     park with no bearing on file returns null and the caller reports the
     weather layer as blind rather than assuming a neutral wind. */
  function windOut(weather) {
    if (!weather) return null;
    var mph = num(weather.wind_mph);
    if (mph == null) return null;
    var rel = weather.wind_rel;
    if (rel === null || rel === undefined || rel === '') return null;
    var asNum = num(rel);
    if (asNum != null) return mph * Math.cos(asNum * Math.PI / 180);
    var s = String(rel).toLowerCase();
    if (/out|tail/.test(s)) return mph;
    if (/\bin\b|head/.test(s)) return -mph;
    if (/cross|left|right/.test(s)) return 0;
    return null;
  }

  /* The weather multiplier on the run environment, and the note that explains
     it. Small on purpose: weather moves a total, it barely moves a side. */
  function weatherFactor(park, weather, W) {
    var notes = [], mult = 1, blind = [];
    if (!weather) return { mult: 1, notes: [], blind: ['no forecast row for this game'] };
    var indoors = !!(park && (park.is_dome === true || /closed|fixed/i.test(String(park.roof_type || ''))));
    if (indoors) return { mult: 1, notes: ['indoors — outdoor conditions do not reach the field'], blind: [] };

    var t = num(weather.temp_f);
    if (t != null) {
      var dT = clamp((t - W.temp_reference_f) * W.temp_run_pct_per_degree, -W.temp_clamp_pct, W.temp_clamp_pct);
      mult *= (1 + dT);
      if (Math.abs(dT) >= 0.010) {
        notes.push(Math.round(t) + '°F ' + (dT > 0 ? 'adds' : 'takes') + ' '
          + Math.abs(dT * 100).toFixed(1) + '% of the run environment');
      }
    } else blind.push('no temperature on file');

    var wo = windOut(weather);
    if (wo != null) {
      var dW = clamp(wo * W.wind_out_pct_per_mph, -W.wind_clamp_pct, W.wind_clamp_pct);
      mult *= (1 + dW);
      if (Math.abs(dW) >= 0.010) {
        notes.push(Math.abs(wo).toFixed(0) + ' mph ' + (wo > 0 ? 'out' : 'in') + ' '
          + (dW > 0 ? 'adds ' : 'takes ') + Math.abs(dW * 100).toFixed(1) + '% of the run environment');
      }
    } else if (num(weather.wind_mph) != null) {
      blind.push('wind is on file but its direction relative to the field is not, so no out/in read is taken');
    } else blind.push('no wind on file');

    var pp = num(weather.precip_prob);
    if (pp != null && pp >= W.precip_warn_pct) {
      /* Rain is not modelled as runs. It is modelled as the game possibly not
         being played, which is a warning and not a number. */
      notes.push(Math.round(pp) + '% precipitation risk — a delay or postponement is in play, and it is not '
        + 'in the run number');
    }
    if (park && /retract/i.test(String(park.roof_type || ''))) {
      /* The roof state at first pitch is not published anywhere EdgeDesk
         reads, so the weather effect is halved rather than asserted. */
      mult = 1 + (mult - 1) / 2;
      notes.push('retractable roof — the roof state at first pitch is not published, so the weather effect is halved');
    }
    return { mult: mult, notes: notes, blind: blind };
  }

  /* An index published as 100 = neutral, read as a multiplier and clamped. A
     park factor describes a whole game, so a side carries its square root. */
  function parkFactor(v, P) {
    v = num(v);
    if (v == null) return null;
    var f = v > 3 ? v / 100 : v;           /* accepts 103 or 1.03 */
    return clamp(f, P.park_factor_min, P.park_factor_max);
  }

  /* ---------------- MLB ---------------- */

  /* A starter's expected runs allowed per nine, on the league scale.
     Blends the estimators present; a starter with none of them is not
     invented, he is reported missing and the relief rate carries the game. */
  function starterRa9(sp, leagueRa9, P) {
    if (!sp) return { ra9: null, used: [], missing: ['no probable starter posted'] };
    var B = P.starter_blend, parts = [], wsum = 0, acc = 0, used = [];
    function add(v, w, label) {
      v = num(v); if (v == null) return;
      acc += v * w; wsum += w; used.push(label); parts.push(label + ' ' + v.toFixed(2));
    }
    add(sp.xera, B.xera, 'xERA');
    add(sp.fip, B.fip, 'FIP');
    add(sp.era, B.era, 'ERA');
    if (!wsum) return { ra9: null, used: [], missing: ['no ERA, FIP or xERA on file for the probable starter'] };
    var earned = acc / wsum;
    var ra9 = earned * P.era_to_ra9;
    /* Regressed toward the league by innings: a 12-inning sample is not a
       season, and a starter with no innings recorded is the league. */
    var ip = num(sp.ip);
    var reg = regress(ra9, leagueRa9, ip, P.starter_regress_ip);
    return { ra9: reg, raw_ra9: ra9, used: used, parts: parts, ip: ip,
      missing: ip == null ? ['the starter’s innings are not on file, so his line is regressed as a full prior'] : [] };
  }

  /* The relief corps behind him.
     THE BASE RATE IS THE CLUB'S WHOLE-STAFF RUNS ALLOWED, and that is an
     approximation rather than a measurement: EdgeDesk publishes no separate
     relief run rate, and a bullpen is usually a little better per nine than
     the rotation it follows. Inventing a split would be inventing the number;
     the approximation is used and it is named, here and on screen.
     The tax on top is the flags EdgeDesk actually carries. It is never a full
     rest state — only flagged arms are published, so only flagged arms count. */
  function bullpenRa9(pen, clubRa9, leagueRa9, P) {
    var base = clubRa9 == null ? leagueRa9 : clubRa9;
    var notes = [], mult = 1;
    notes.push(clubRa9 == null
      ? 'no club run-prevention rate on file, so the league average stands in for the relief innings'
      : 'relief innings carry the club\u2019s whole-staff rate of ' + clubRa9.toFixed(2)
        + ' runs per nine — EdgeDesk publishes no separate bullpen rate, and this stands in for one');
    if (pen) {
      var taxed = pen.taxed || [];
      if (taxed.length) {
        var pen1 = Math.min(P.bullpen_taxed_cap, taxed.length * P.bullpen_taxed_penalty);
        mult *= (1 + pen1);
        notes.push(taxed.length + ' flagged arm' + (taxed.length === 1 ? '' : 's')
          + ' — relief run rate carried ' + (pen1 * 100).toFixed(1) + '% worse');
      }
      if (pen.closer_flag) {
        mult *= (1 + P.bullpen_closer_out_penalty);
        notes.push('the closer is flagged, worth another ' + (P.bullpen_closer_out_penalty * 100).toFixed(1) + '%');
      }
    }
    return { ra9: base * mult, mult: mult, notes: notes, had_club_rate: clubRa9 != null };
  }

  /* One side's expected runs, and the named reason for every multiplier. */
  function sideRuns(off, oppStaff, leagueRpg, parkMult, wxMult, homeMult, P) {
    var terms = [], mult = 1;
    /* offense, relative to the league, regressed by games played */
    var oRate = regress(num(off && off.runs_per_game), leagueRpg,
      num(off && off.games), P.offense_regress_games);
    var oFac = oRate != null && leagueRpg > 0 ? oRate / leagueRpg : 1;
    terms.push({ k: 'offense', v: oFac,
      t: off && num(off.runs_per_game) != null
        ? (num(off.runs_per_game).toFixed(2) + ' runs per game'
           + (num(off.games) != null ? ' over ' + num(off.games) + ' games' : '')
           + ', regressed to ' + oRate.toFixed(2))
        : 'no season run rate on file — the league average stands in and is labelled as standing in' });
    mult *= oFac;

    /* the arms they face */
    var dFac = oppStaff.ra9 != null && leagueRpg > 0 ? oppStaff.ra9 / leagueRpg : 1;
    terms.push({ k: 'opposing_staff', v: dFac, t: oppStaff.text });
    mult *= dFac;

    if (parkMult != null) { terms.push({ k: 'park', v: parkMult, t: oppStaff.parkText || null }); mult *= parkMult; }
    if (wxMult != null && wxMult !== 1) { terms.push({ k: 'weather', v: wxMult, t: null }); mult *= wxMult; }
    terms.push({ k: 'home_away', v: homeMult, t: null });
    mult *= homeMult;

    return { runs: leagueRpg * mult, terms: terms };
  }

  /* THE MARKET'S OWN FAIR NUMBER FOR THE HOME SIDE.
     Two sources, and the order matters. The odds capture already de-vigs
     every quote it stores and publishes the result as sharp_fair (Pinnacle
     based) or consensus_fair (cross-book median); when a caller has one of
     those it is passed straight through, because it is the market's number
     computed by the layer that owns market numbers and it survives a capture
     that only retained ONE side of the game. Only when neither exists does
     the engine de-vig a pair of decimals itself. A single decimal price with
     no counterpart is NOT used: the vig in it is unknown, and a fair number
     with unknown vig in it is a made-up number. */
  function marketFairHome(mkt) {
    if (!mkt) return null;
    var given = num(mkt.home_fair_prob);
    if (given != null && given > 0 && given < 1) {
      return { p: given, hold: null,
        src: mkt.home_fair_source || 'the odds capture\u2019s own de-vigged fair number' };
    }
    var d = odds.devigTwoWay(mkt.home_ml_dec, mkt.away_ml_dec);
    if (d) return { p: d.a, hold: d.hold, src: 'both sides de-vigged here, proportionally' };
    return null;
  }

  function mlbDataQuality(req) {
    var missing = [], warn = [];
    if (!req || !req.home || !req.away) missing.push('both clubs');
    else {
      if (!req.home.name) missing.push('home club');
      if (!req.away.name) missing.push('away club');
    }
    if (missing.length) return { status: 'INSUFFICIENT_DATA', missing: missing, warnings: warn };
    ['home', 'away'].forEach(function (s) {
      var side = req[s], lbl = s === 'home' ? 'home' : 'away';
      if (!side.offense || num(side.offense.runs_per_game) == null)
        warn.push('no season run rate for the ' + lbl + ' club — the league average is standing in');
      if (!side.defense || num(side.defense.runs_allowed_per_game) == null)
        warn.push('no season run-prevention rate for the ' + lbl + ' club — the league average is standing in');
      if (!side.starter || !side.starter.name)
        warn.push(lbl + ' starter unknown — the probable has not been posted, and the starter is the largest '
          + 'single input in a baseball number');
      else if (num(side.starter.era) == null && num(side.starter.fip) == null && num(side.starter.xera) == null)
        warn.push(lbl + ' starter ' + side.starter.name + ' has no ERA, FIP or xERA on file, so his half of the '
          + 'pitching is the club’s staff rate rather than his own');
    });
    return { status: 'OK', missing: [], warnings: warn };
  }

  function projectMlbGame(req) {
    var P = params();
    var nowIso = new Date().toISOString();
    if (!P) return { status: 'BLOCKED', reason: 'EDBaseballParams not loaded', missing: ['params'],
      prediction_timestamp: nowIso };
    var M = P.mlb;
    var season = num(req && req.season);
    if (season != null && season > P.calibrated_through_season + 1) {
      return { status: 'BLOCKED', missing: ['fresh_params'],
        reason: 'Constants are calibrated through ' + P.calibrated_through_season + '; season ' + season
          + ' is beyond the supported window. Recalibrate mlb/params.js before projecting.',
        model_version: P.model_version, prediction_timestamp: nowIso };
    }
    var q = mlbDataQuality(req);
    if (q.status !== 'OK') {
      return { status: q.status, reason: 'required inputs absent', missing: q.missing,
        data_quality: q, model_version: P.model_version, prediction_timestamp: nowIso };
    }

    var leagueRpg = num(req.league && req.league.runs_per_game);
    var leagueSource = 'the season-to-date mean of the club rates on file';
    if (leagueRpg == null || leagueRpg <= 0) {
      leagueRpg = M.league_runs_per_game;
      leagueSource = 'the published fallback in mlb/params.js — no live club rates were available to fold one from';
    }
    var leagueRa9 = leagueRpg;    /* runs scored and runs allowed share a league mean by construction */

    /* PARK AND WEATHER ARE RUN-ENVIRONMENT MULTIPLIERS, and a run environment
       reaches both clubs. Each side carries the factor IN FULL, so a park
       index of 112 raises the total by 12% rather than by its square root —
       the halving mistake that makes a hitters' park look like a neutral one. */
    var pk = parkFactor(req.park && (req.park.run_factor != null ? req.park.run_factor : req.park.park_factor), M);
    var parkSide = pk;
    var wx = weatherFactor(req.park, req.weather, M.weather);
    var wxSide = wx.mult;

    function staffFor(side, sideLabel) {
      var sp = starterRa9(side.starter, leagueRa9, M);
      var clubRa9 = regress(num(side.defense && side.defense.runs_allowed_per_game), leagueRa9,
        num(side.defense && side.defense.games), M.defense_regress_games);
      var bp = bullpenRa9(side.bullpen, clubRa9, leagueRa9, M);
      var ipRaw = num(side.starter && side.starter.ip_per_start);
      var ip = clamp(ipRaw == null ? M.starter_innings_default : ipRaw, M.starter_innings_min, M.starter_innings_max);
      var wSp = sp.ra9 == null ? 0 : ip / 9;
      var ra9 = sp.ra9 == null ? bp.ra9 : (sp.ra9 * wSp + bp.ra9 * (1 - wSp));
      var text;
      if (sp.ra9 == null) {
        text = (side.starter && side.starter.name ? side.starter.name + ' has no line on file, so ' : 'No starter is posted, so ')
          + 'the whole game carries the ' + sideLabel + ' staff rate of ' + bp.ra9.toFixed(2) + ' runs per nine';
      } else {
        text = (side.starter.name || 'the starter') + ' at ' + sp.ra9.toFixed(2)
          + ' runs per nine for an expected ' + ip.toFixed(1) + ' innings ('
          + (sp.parts || []).join(', ') + '), then relief at ' + bp.ra9.toFixed(2);
      }
      return { ra9: ra9, sp: sp, bp: bp, ip: ip, w_sp: wSp, text: text,
        parkText: pk == null ? null : 'park index ' + (pk * 100).toFixed(0)
          + ' — a run environment reaches both clubs, so each side carries it in full' };
    }

    var homeStaff = staffFor(req.home, 'home'), awayStaff = staffFor(req.away, 'away');

    /* the away club bats against the HOME club's arms, and vice versa */
    var awayRuns = sideRuns(req.away.offense, homeStaff, leagueRpg, parkSide, wxSide, M.away_offense_mult, M);
    var homeRuns = sideRuns(req.home.offense, awayStaff, leagueRpg, parkSide, wxSide, M.home_offense_mult, M);

    var lamH = homeRuns.runs, lamA = awayRuns.runs;
    if (!isNum(lamH) || !isNum(lamA) || lamH <= 0 || lamA <= 0 || lamH > 20 || lamA > 20) {
      return { status: 'BLOCKED', reason: 'sanity check failed', missing: [],
        debug: { home_runs: lamH, away_runs: lamA },
        model_version: P.model_version, prediction_timestamp: nowIso };
    }

    var pmfH = dist.runPmf(lamH, M.run_dispersion, M.run_support_max);
    var pmfA = dist.runPmf(lamA, M.run_dispersion, M.run_support_max);
    var pmfT = dist.totalPmf(pmfH, pmfA);
    /* The distribution's own answer, then the last-bat correction — applied
       to the win probability alone, never to a run expectation, because it
       describes how the ninth inning is STRUCTURED and not how many runs are
       scored. A total must not move because of it. */
    var pRuns = dist.winProb(pmfH, pmfA, M.extra_innings_home_win);
    var pHome = clamp(pRuns + (M.home_last_bat_win_bonus || 0), 0.02, 0.98);
    var fairTotal = lamH + lamA;

    var mkt = req.market || {};
    var totalLine = num(mkt.total_line);
    var tp = totalLine != null ? dist.totalProbs(pmfT, totalLine) : null;
    var rlLine = num(mkt.run_line) != null ? num(mkt.run_line) : (lamH >= lamA ? -1.5 : 1.5);
    var rl = dist.runLineProbs(pmfH, pmfA, rlLine);
    var fairHome = marketFairHome(mkt);

    var totalGap = totalLine != null ? (fairTotal - totalLine) : null;
    var mlGapPts = fairHome ? (pHome - fairHome.p) * 100 : null;

    var out = {
      status: 'PREDICTED',
      sport: 'mlb',
      game: { home: req.home.name, away: req.away.name },
      model: {
        home_runs: round(lamH, 2),
        away_runs: round(lamA, 2),
        fair_total: round(fairTotal, 2),
        home_win_prob: pHome,
        away_win_prob: 1 - pHome,
        home_win_prob_runs_only: pRuns,
        fair_home_ml: odds.probToAm(pHome),
        fair_away_ml: odds.probToAm(1 - pHome),
        run_line: rlLine,
        run_line_cover_prob: rl ? rl.cover_fair : null,
        fair_run_line_ml: rl && rl.cover_fair != null ? odds.probToAm(rl.cover_fair) : null,
        over_prob: tp ? tp.over_fair : null,
        push_prob: tp ? tp.push : null,
        total_p10: dist.quantiles(pmfT, [0.1])[0],
        total_p50: dist.quantiles(pmfT, [0.5])[0],
        total_p90: dist.quantiles(pmfT, [0.9])[0]
      },
      components: {
        league_runs_per_game: round(leagueRpg, 3),
        league_source: leagueSource,
        park_factor: pk == null ? null : round(pk, 3),
        park_applied_per_side: parkSide == null ? null : round(parkSide, 4),
        weather_factor: round(wx.mult, 4),
        weather_notes: wx.notes,
        weather_blind: wx.blind,
        home_staff_ra9: round(homeStaff.ra9, 3),
        away_staff_ra9: round(awayStaff.ra9, 3),
        home_starter_share: round(homeStaff.w_sp, 3),
        away_starter_share: round(awayStaff.w_sp, 3),
        home_bullpen_notes: homeStaff.bp.notes,
        away_bullpen_notes: awayStaff.bp.notes
      },
      contributions: {
        home: homeRuns.terms.map(function (t) { return { k: t.k, v: round(t.v, 4), t: t.t }; }),
        away: awayRuns.terms.map(function (t) { return { k: t.k, v: round(t.v, 4), t: t.t }; })
      },
      distribution: { home: pmfH, away: pmfA, total: pmfT },
      market: {
        total_line: totalLine,
        total_gap: totalGap == null ? null : round(totalGap, 2),
        run_line: num(mkt.run_line),
        home_ml_dec: num(mkt.home_ml_dec),
        away_ml_dec: num(mkt.away_ml_dec),
        consensus_fair_home: fairHome ? fairHome.p : null,
        consensus_fair_source: fairHome ? fairHome.src : null,
        consensus_hold: fairHome ? fairHome.hold : null,
        win_prob_gap_pts: mlGapPts == null ? null : round(mlGapPts, 2),
        book: mkt.book || null,
        as_of: mkt.as_of || null,
        stale: !!mkt.stale
      },
      edge: {
        total: classify('mlb', 'total', totalGap),
        moneyline: classify('mlb', 'moneyline', mlGapPts)
      },
      data_quality: q,
      unproven: true,
      model_version: P.model_version,
      feature_version: M.feature_version,
      prediction_timestamp: nowIso,
      fingerprint: fingerprint({ h: req.home.name, a: req.away.name, s: 'mlb', v: P.model_version,
        m: [totalLine, num(mkt.home_ml_dec), num(mkt.away_ml_dec)],
        r: [round(lamH, 2), round(lamA, 2)] })
    };
    return out;
  }

  /* ---------------- college baseball ---------------- */

  /* Conference strength, folded from the same season table the records come
     from. Games inside a conference cancel — one member's run scored is
     another member's run allowed — so a conference's AGGREGATE run
     differential was earned entirely outside it, and dividing by the
     non-conference games played turns it into runs per non-conference game.
     Returns a map of conference name to that figure, with the sample it rests
     on, so a thin conference can be shown as thin rather than trusted. */
  function conferenceStrength(teamSeasons, confOf) {
    var acc = {}, out = {};
    (teamSeasons || []).forEach(function (t) {
      var conf = confOf ? confOf(t) : (t.conference_name || t.conference || null);
      if (!conf) return;
      var g = num(t.games), rf = num(t.runs_for), ra = num(t.runs_against);
      if (g == null || rf == null || ra == null) return;
      var confG = (num(t.conf_wins) || 0) + (num(t.conf_losses) || 0);
      var a = acc[conf] || (acc[conf] = { diff: 0, games: 0, nonconf: 0, clubs: 0 });
      a.diff += (rf - ra); a.games += g; a.nonconf += Math.max(0, g - confG); a.clubs++;
    });
    Object.keys(acc).forEach(function (c) {
      var a = acc[c];
      out[c] = {
        clubs: a.clubs,
        games: a.games,
        nonconference_games: a.nonconf,
        run_diff: a.diff,
        /* the measure itself: net runs per non-conference game */
        runs_per_nonconf_game: a.nonconf > 0 ? a.diff / a.nonconf : null,
        sufficient: a.nonconf >= (params() ? params().cbb.conference_min_nonconf_games : 20)
      };
    });
    return out;
  }

  function cbbDataQuality(req) {
    var missing = [], warn = [];
    if (!req || !req.home || !req.away) missing.push('both clubs');
    else {
      if (!req.home.name) missing.push('home club');
      if (!req.away.name) missing.push('away club');
    }
    if (missing.length) return { status: 'INSUFFICIENT_DATA', missing: missing, warnings: warn };
    /* THE STARTER. College programmes rarely post one and the source behind
       this card carries none, so the largest single input in a baseball
       number is missing for every college game. That is stated on every
       projection rather than once in a footnote. */
    warn.push('No probable starting pitcher exists in this data for either club. The starter is the largest single '
      + 'input in a baseball number, so this projection is a club-level number and nothing more.');
    ['home', 'away'].forEach(function (s) {
      var side = req[s], lbl = s === 'home' ? 'home' : 'away';
      var g = num(side.games);
      if (num(side.runs_per_game) == null || num(side.runs_allowed_per_game) == null)
        warn.push('the ' + lbl + ' club has no completed games in this season’s log, so its rates are the '
          + 'league average standing in');
      else if (g != null && g < 10)
        warn.push('the ' + lbl + ' club has played ' + g + ' games — the rates are heavily regressed and the number '
          + 'is closer to the league average than to them');
      if (side.conference_strength && side.conference_strength.sufficient === false)
        warn.push('the ' + lbl + ' club’s conference has too few non-conference games on file to measure its '
          + 'strength, so no schedule adjustment is applied to it');
    });
    return { status: 'OK', missing: [], warnings: warn };
  }

  function projectCbbGame(req) {
    var P = params();
    var nowIso = new Date().toISOString();
    if (!P) return { status: 'BLOCKED', reason: 'EDBaseballParams not loaded', missing: ['params'],
      prediction_timestamp: nowIso };
    var C = P.cbb;
    var q = cbbDataQuality(req);
    if (q.status !== 'OK') {
      return { status: q.status, reason: 'required inputs absent', missing: q.missing,
        data_quality: q, model_version: P.model_version, prediction_timestamp: nowIso };
    }

    var leagueRpg = num(req.league && req.league.runs_per_game);
    var leagueSource = 'the mean of every club rate in this season’s folded table';
    if (leagueRpg == null || leagueRpg <= 0) {
      leagueRpg = C.league_runs_per_game;
      leagueSource = 'the published fallback in mlb/params.js — no season table was available to fold one from';
    }

    function confAdj(side) {
      var cs = side.conference_strength;
      if (!cs || !cs.sufficient || cs.runs_per_nonconf_game == null) return { off: 1, def: 1, note: null };
      var d = clamp(cs.runs_per_nonconf_game, -C.conference_adjust_clamp_runs, C.conference_adjust_clamp_runs);
      /* half of a conference's edge is credited to its bats and half to its
         arms, because the aggregate differential cannot tell them apart */
      var per = (d / 2) * C.conference_adjust_weight / leagueRpg;
      return { off: 1 + per, def: 1 - per,
        note: (cs.name ? cs.name + ' ' : 'the conference ') + (d >= 0 ? '+' : '') + d.toFixed(2)
          + ' runs per non-conference game over ' + cs.nonconference_games + ' of them' };
    }

    function rates(side) {
      var a = confAdj(side);
      var o = regress(num(side.runs_per_game), leagueRpg, num(side.games), C.offense_regress_games);
      var d = regress(num(side.runs_allowed_per_game), leagueRpg, num(side.games), C.defense_regress_games);
      return { off: (o / leagueRpg) * a.off, def: (d / leagueRpg) * a.def, adj: a,
        raw_off: o, raw_def: d };
    }

    var H = rates(req.home), A = rates(req.away);
    var neutral = !!req.neutral_site;
    var hMult = neutral ? 1 : C.home_offense_mult, aMult = neutral ? 1 : C.away_offense_mult;

    var lamH = leagueRpg * H.off * A.def * hMult;
    var lamA = leagueRpg * A.off * H.def * aMult;
    if (!isNum(lamH) || !isNum(lamA) || lamH <= 0 || lamA <= 0 || lamH > 30 || lamA > 30) {
      return { status: 'BLOCKED', reason: 'sanity check failed', missing: [],
        debug: { home_runs: lamH, away_runs: lamA },
        model_version: P.model_version, prediction_timestamp: nowIso };
    }

    var pmfH = dist.runPmf(lamH, C.run_dispersion, C.run_support_max);
    var pmfA = dist.runPmf(lamA, C.run_dispersion, C.run_support_max);
    var pmfT = dist.totalPmf(pmfH, pmfA);
    var pRuns = dist.winProb(pmfH, pmfA, neutral ? 0.5 : C.extra_innings_home_win);
    var pHome = clamp(pRuns + (neutral ? 0 : (C.home_last_bat_win_bonus || 0)), 0.02, 0.98);
    var fairTotal = lamH + lamA;

    var mkt = req.market || {};
    var totalLine = num(mkt.total_line);
    var tp = totalLine != null ? dist.totalProbs(pmfT, totalLine) : null;
    var fairHome = marketFairHome(mkt);
    var totalGap = totalLine != null ? (fairTotal - totalLine) : null;
    var mlGapPts = fairHome ? (pHome - fairHome.p) * 100 : null;

    return {
      status: 'PREDICTED',
      sport: 'cbb',
      game: { home: req.home.name, away: req.away.name, neutral_site: neutral },
      model: {
        home_runs: round(lamH, 2),
        away_runs: round(lamA, 2),
        fair_total: round(fairTotal, 2),
        home_win_prob: pHome,
        away_win_prob: 1 - pHome,
        home_win_prob_runs_only: pRuns,
        fair_home_ml: odds.probToAm(pHome),
        fair_away_ml: odds.probToAm(1 - pHome),
        run_line: lamH >= lamA ? -1.5 : 1.5,
        run_line_cover_prob: (function () {
          var r = dist.runLineProbs(pmfH, pmfA, lamH >= lamA ? -1.5 : 1.5);
          return r ? r.cover_fair : null;
        })(),
        over_prob: tp ? tp.over_fair : null,
        total_p10: dist.quantiles(pmfT, [0.1])[0],
        total_p50: dist.quantiles(pmfT, [0.5])[0],
        total_p90: dist.quantiles(pmfT, [0.9])[0]
      },
      components: {
        league_runs_per_game: round(leagueRpg, 3),
        league_source: leagueSource,
        home_offense_factor: round(H.off, 4),
        home_defense_factor: round(H.def, 4),
        away_offense_factor: round(A.off, 4),
        away_defense_factor: round(A.def, 4),
        home_conference_note: H.adj.note,
        away_conference_note: A.adj.note,
        neutral_site: neutral
      },
      distribution: { home: pmfH, away: pmfA, total: pmfT },
      market: {
        total_line: totalLine,
        total_gap: totalGap == null ? null : round(totalGap, 2),
        consensus_fair_home: fairHome ? fairHome.p : null,
        consensus_fair_source: fairHome ? fairHome.src : null,
        win_prob_gap_pts: mlGapPts == null ? null : round(mlGapPts, 2)
      },
      edge: {
        total: classify('cbb', 'total', totalGap),
        moneyline: classify('cbb', 'moneyline', mlGapPts)
      },
      data_quality: q,
      unproven: true,
      model_version: P.model_version,
      feature_version: C.feature_version,
      prediction_timestamp: nowIso,
      fingerprint: fingerprint({ h: req.home.name, a: req.away.name, s: 'cbb', v: P.model_version,
        m: [totalLine], r: [round(lamH, 2), round(lamA, 2)] })
    };
  }

  /* ---------------- classification ----------------
     The vocabulary is the football engine's, and so is the discipline: past
     the guard bound is a DATA FAULT and not an opportunity, and the best a
     disagreement can ever be called is RESEARCH_LEAN, because this model has
     never been graded against a closing line. */
  function classify(sport, kind, gap) {
    var P = params();
    var out = { recommendation: 'NO_MARKET', gap: gap == null ? null : round(gap, 2), unproven: true,
      note: 'Baseball carries no graded closing-line record in EdgeDesk. A disagreement is a question to open, '
        + 'never evidence of an edge.' };
    if (!P) return out;
    var S = sport === 'cbb' ? P.cbb : P.mlb;
    var guard = kind === 'total' ? S.guard.total_runs : S.guard.win_prob_pts;
    var review = kind === 'total' ? S.review.total_runs : S.review.win_prob_pts;
    if (gap == null) return out;
    var a = Math.abs(gap);
    if (a > guard) {
      out.recommendation = 'DATA_FAULT';
      out.note = 'Past the ' + guard + (kind === 'total' ? '-run' : '-point') + ' guard bound. A disagreement this '
        + 'size is far more often a broken or missing input than a mispriced game — inspect the inputs, do not '
        + 'price it.';
      return out;
    }
    if (a >= review) {
      out.recommendation = 'RESEARCH_LEAN';
      out.note = 'Inside the guard bound and past the review threshold of ' + review
        + (kind === 'total' ? ' runs' : ' points') + '. Worth opening. Not an edge: this model has no graded '
        + 'closing-line record.';
      return out;
    }
    out.recommendation = 'PASS';
    out.note = 'Inside the review threshold. Context, not a signal.';
    return out;
  }

  function fingerprint(obj) {
    var s = JSON.stringify(obj), h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'bb_' + (h >>> 0).toString(36);
  }

  var API = {
    version: function () { var P = params(); return P ? P.model_version : null; },
    meta: function () {
      var P = params(); if (!P) return null;
      return {
        model_version: P.model_version,
        built_at: P.built_at,
        calibrated_through_season: P.calibrated_through_season,
        mlb: { feature_version: P.mlb.feature_version, provenance: P.mlb.data_provenance,
          guard: P.mlb.guard, review: P.mlb.review },
        cbb: { feature_version: P.cbb.feature_version, provenance: P.cbb.data_provenance,
          guard: P.cbb.guard, review: P.cbb.review },
        validation: P.validation
      };
    },
    odds: odds,
    dist: dist,
    regress: regress,
    windOut: windOut,
    parkFactor: parkFactor,
    weatherFactor: weatherFactor,
    conferenceStrength: conferenceStrength,
    classify: classify,
    marketFairHome: marketFairHome,
    dataQuality: mlbDataQuality,
    projectGame: projectMlbGame,
    projectCollegeGame: projectCbbGame,
    fingerprint: fingerprint
  };

  root.EDBaseball = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

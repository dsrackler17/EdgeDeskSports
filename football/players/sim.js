/* ============================================================================
   THE HEAD-TO-HEAD SIMULATOR, THE LINE LADDER, AND THE TWO QUESTIONS THAT
   MATTER MORE THAN THE NUMBER: what keeps this close, and what breaks it.

   REPRODUCIBILITY IS A FEATURE, NOT A DETAIL. The generator is a seeded
   mulberry32 and the default seed is fixed in config.js. The same inputs and
   the same seed produce a bit-identical distribution on every machine, every
   time. A simulator you cannot re-run is a simulator you cannot check.

   IT DOES NOT INVENT A DISTRIBUTION. The margin is drawn from the Power 4
   engine's own spread-conditioned margin table when the caller supplies one —
   the table that already knows college football's key numbers are not the
   NFL's, and that there are no ties. Only when no table is supplied does it
   fall back to a rounded normal, and it says which of the two it did.

   THE LADDER KEEPS THE MARKET OUT. RAW MODEL -> PLAYER-ADJUSTED ->
   SCHEME-ADJUSTED -> SIMULATION are four separately published numbers, each
   derived from the one before it. The market is never an input to any of them.
   The two scalars that turn matchup points into points of spread live in
   params.js with their own walk-forward record and a `points_applied` flag
   that is allowed to be false — and when it is false, the ladder step is flat
   and says why.

   Runs in the browser (window.EDPlayerSim) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDPlayerConfig;
  var epir = req ? require('./epir.js') : root.EDPlayerRating;
  var api = factory(cfg, epir);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPlayerSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG, EPIR) {
  'use strict';

  var SCHEMA = 'edgedesk_h2h_simulation_v1';
  var isNum = EPIR.isNum, clamp = EPIR.clamp;
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }

  /* --------------------------------------------------------------------
     Deterministic generator. mulberry32: 32-bit state, uniform, fast, and
     identical in every JavaScript engine. Same seed, same game, forever.
     -------------------------------------------------------------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* Box-Muller, drawing both normals so the stream stays deterministic. */
  function normalPair(rnd) {
    var u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    var r = Math.sqrt(-2 * Math.log(u1)), th = 2 * Math.PI * u2;
    return [r * Math.cos(th), r * Math.sin(th)];
  }

  /* Sample from a { value: probability } PMF using a prebuilt CDF. */
  function buildCdf(pmf) {
    var keys = [], k, tot = 0;
    for (k in pmf) if (Object.prototype.hasOwnProperty.call(pmf, k)) { keys.push(+k); }
    keys.sort(function (a, b) { return a - b; });
    var cdf = [], acc = 0, i;
    for (i = 0; i < keys.length; i++) { acc += pmf[keys[i]]; cdf.push(acc); }
    tot = acc;
    if (!(tot > 0)) return null;
    for (i = 0; i < cdf.length; i++) cdf[i] /= tot;
    return { keys: keys, cdf: cdf };
  }
  function sampleCdf(c, u) {
    var lo = 0, hi = c.cdf.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (c.cdf[mid] < u) lo = mid + 1; else hi = mid; }
    return c.keys[lo];
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var i = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1);
    return sorted[i];
  }

  /* --------------------------------------------------------------------
     THE SIMULATION
     req = {
       fair_spread     home-favoured margin, engine convention (+3 = home by 3)
       sigma_margin    the model's own measured spread of the margin
       fair_total      projected combined points
       sigma_total     its spread
       margin_pmf      OPTIONAL { margin: probability } from the Power 4 engine
       market_spread   OPTIONAL, used ONLY to report a cover probability and
                       never as an input to any projection
       market_total    OPTIONAL, same rule
       draws, seed
     }
     -------------------------------------------------------------------- */
  function simulate(req) {
    req = req || {};
    var S = CFG.SIMULATION;
    var draws = clamp(num(req.draws) || S.default_draws, 100, S.max_draws);
    var seed = num(req.seed) == null ? S.default_seed : num(req.seed);
    var fs = num(req.fair_spread), sm = num(req.sigma_margin);
    var ft = num(req.fair_total), st = num(req.sigma_total);
    if (fs == null || !(sm > 0)) {
      return { schema: SCHEMA, status: 'BLOCKED', draws: 0,
        reason: 'the simulator needs a fair spread and a measured sigma from the projection engine. It will not invent either.' };
    }
    var totalKnown = (ft != null && st > 0);
    var rho = num(req.margin_total_corr);
    if (rho == null) rho = S.fallback_margin_total_corr;
    rho = clamp(rho, -0.9, 0.9);

    var cdf = req.margin_pmf ? buildCdf(req.margin_pmf) : null;
    var rnd = mulberry32(seed >>> 0);
    var margins = new Array(draws), totals = totalKnown ? new Array(draws) : null;
    var homeScores = new Array(draws), awayScores = new Array(draws);
    var i, m, t, z;
    for (i = 0; i < draws; i++) {
      var pair = normalPair(rnd);
      if (cdf) {
        /* draw the margin from the engine's own table, which already carries
           college football's key-number mass and its complete absence of ties */
        m = sampleCdf(cdf, rnd());
      } else {
        m = Math.round(fs + pair[0] * sm);
      }
      margins[i] = m;
      if (totalKnown) {
        z = rho * ((m - fs) / sm) + Math.sqrt(1 - rho * rho) * pair[1];
        t = ft + z * st;
        if (t < Math.abs(m)) t = Math.abs(m);        /* a total cannot be smaller than the margin */
        totals[i] = t;
        var h = (t + m) / 2, a = (t - m) / 2;
        homeScores[i] = Math.max(0, Math.round(h));
        awayScores[i] = Math.max(0, Math.round(a));
      }
    }
    var sortedM = margins.slice().sort(function (a2, b2) { return a2 - b2; });
    var sortedT = totalKnown ? totals.slice().sort(function (a2, b2) { return a2 - b2; }) : null;
    var sortedH = totalKnown ? homeScores.slice().sort(function (a2, b2) { return a2 - b2; }) : null;
    var sortedA = totalKnown ? awayScores.slice().sort(function (a2, b2) { return a2 - b2; }) : null;

    function share(fn) { var c = 0; for (var j = 0; j < draws; j++) if (fn(margins[j], totalKnown ? totals[j] : null)) c++; return c / draws; }
    var mean = 0; for (i = 0; i < draws; i++) mean += margins[i]; mean /= draws;

    var out = {
      schema: SCHEMA, status: 'SIMULATED', version: CFG.versions.simulation,
      draws: draws, seed: seed,
      distribution_source: cdf
        ? 'the Power 4 engine’s own spread-conditioned margin table (measured key-number mass, no ties)'
        : 'a rounded normal, because no margin table was supplied — this is the weaker of the two and is labelled so',
      margin: {
        mean: r1(mean), median: quantile(sortedM, 0.5),
        p10: quantile(sortedM, 0.10), p25: quantile(sortedM, 0.25),
        p50: quantile(sortedM, 0.50), p75: quantile(sortedM, 0.75), p90: quantile(sortedM, 0.90),
        sigma: r1(sm)
      },
      home_win_prob: r3(share(function (mm) { return mm > 0; })),
      away_win_prob: r3(share(function (mm) { return mm < 0; })),
      tie_prob: r3(share(function (mm) { return mm === 0; })),
      one_score_prob: r3(share(function (mm) { return Math.abs(mm) <= S.one_score; })),
      blowout_prob: r3(share(function (mm) { return Math.abs(mm) >= S.blowout; })),
      favourite: fs > 0 ? 'home' : (fs < 0 ? 'away' : null),
      upset_prob: r3(fs > 0 ? share(function (mm) { return mm < 0; }) : (fs < 0 ? share(function (mm) { return mm > 0; }) : null)),
      total: null, scores: null, cover: null, over: null
    };
    if (totalKnown) {
      out.total = { mean: r1(avg(totals)), median: r1(quantile(sortedT, 0.5)),
        p10: r1(quantile(sortedT, 0.10)), p25: r1(quantile(sortedT, 0.25)),
        p50: r1(quantile(sortedT, 0.50)), p75: r1(quantile(sortedT, 0.75)), p90: r1(quantile(sortedT, 0.90)),
        sigma: r1(st) };
      out.scores = {
        home: { mean: r1(avg(homeScores)), median: quantile(sortedH, 0.5), p10: quantile(sortedH, 0.10), p90: quantile(sortedH, 0.90) },
        away: { mean: r1(avg(awayScores)), median: quantile(sortedA, 0.5), p10: quantile(sortedA, 0.10), p90: quantile(sortedA, 0.90) },
        basis: CFG.SIMULATION.score_split_basis
      };
    }
    /* the market is reported against, never fed in */
    var ms = num(req.market_spread);
    if (ms != null) {
      var win = share(function (mm) { return mm > ms; });
      var push = share(function (mm) { return mm === ms; });
      out.cover = { line: ms, home_covers: r3(win), push: r3(push), away_covers: r3(1 - win - push),
        basis: 'counted over the simulated margins. The market line entered here and nowhere else: it is not an input to the spread, the total or any rating.' };
    }
    var mt = num(req.market_total);
    if (mt != null && totalKnown) {
      var ov = share(function (mm, tt) { return tt > mt; });
      out.over = { line: mt, over: r3(ov), under: r3(1 - ov),
        basis: 'counted over the simulated totals; the market total is not an input to anything' };
    }
    return out;
  }
  function avg(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : null; }
  function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
  function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

  /* --------------------------------------------------------------------
     THE LINE LADDER
     raw -> player-adjusted -> scheme-adjusted -> simulation, plus a
     deliberately conservative research fair range. The market is displayed
     beside it and is never one of the rungs.
     -------------------------------------------------------------------- */
  /* a reason string may already end in a full stop; two of them in a row reads
     like a typo and this panel cannot afford to look sloppy about its own
     caveats */
  function trimDot(s) { return /[.!?]$/.test(s) ? s : s + '.'; }

  function ladder(req) {
    var P = req.params || {};
    var cal = P.calibration || {};
    var raw = num(req.raw_model_spread);
    var steps = [], notes = [];
    if (raw == null) {
      return { schema: SCHEMA, available: false,
        reason: 'the ladder starts at the existing engine’s own fair spread. Without it there is nothing to adjust and nothing is invented in its place.' };
    }
    steps.push({ id: 'raw_model', label: 'Raw model', spread: r1(raw),
      basis: 'the Power 4 engine’s published fair spread, unchanged' });

    var pg = num(req.player_quality_gap), sg = num(req.scheme_gap);
    var pc = cal.player_points_per_unit, sc = cal.scheme_points_per_unit;
    var playerAdj = raw, schemeAdj = raw;

    if (pg == null) {
      notes.push('no player-quality gap was available for this game, so the player-adjusted rung is the raw model unchanged');
    } else if (!pc || pc.points_applied !== true) {
      notes.push(trimDot('the player-quality scalar is published with points_applied:false' +
        (pc && pc.reason ? ' — ' + pc.reason : ' — it has not earned its keep out of sample, so it moves no line'))
        + ' The gap is shown, and it changes nothing.');
    } else {
      playerAdj = raw + pg * pc.value;
    }
    steps.push({ id: 'player_adjusted', label: 'Player-adjusted', spread: r1(playerAdj),
      delta: r1(playerAdj - raw), input: pg,
      applied: !!(pc && pc.points_applied === true && pg != null),
      basis: pc ? pc.basis : 'no calibrated scalar has been fitted yet' });

    schemeAdj = playerAdj;
    if (sg == null) {
      notes.push('no scheme gap was available for this game, so the scheme-adjusted rung is the player-adjusted number unchanged');
    } else if (!sc || sc.points_applied !== true) {
      notes.push(trimDot('the scheme scalar is published with points_applied:false' +
        (sc && sc.reason ? ' — ' + sc.reason : ''))
        + ' The scheme edges are shown, and they change nothing.');
    } else {
      schemeAdj = playerAdj + sg * sc.value;
    }
    steps.push({ id: 'scheme_adjusted', label: 'Scheme-adjusted', spread: r1(schemeAdj),
      delta: r1(schemeAdj - playerAdj), input: sg,
      applied: !!(sc && sc.points_applied === true && sg != null),
      basis: sc ? sc.basis : 'no calibrated scalar has been fitted yet' });

    var sim = num(req.simulation_spread);
    if (sim != null) steps.push({ id: 'simulation', label: 'Simulation', spread: r1(sim),
      delta: r1(sim - schemeAdj), applied: true,
      basis: 'the median margin of the Monte Carlo, which is the ladder’s own last rung re-expressed through the distribution' });

    var vals = steps.map(function (s) { return s.spread; }).filter(function (v) { return v != null; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var mid = (lo + hi) / 2;
    var L = CFG.LINE_LADDER.fair_range;
    var q = num(req.data_quality);
    var half = clamp((hi - lo) / 2 + (q == null ? L.quality_widening : (1 - q) * L.quality_widening),
      L.min_half_width, L.max_half_width);

    return {
      schema: SCHEMA, available: true, steps: steps, notes: notes,
      fair_range: { low: r1(mid - half), high: r1(mid + half), centre: r1(mid), half_width: r1(half),
        basis: L.basis },
      market: req.market_spread == null ? null : { spread: num(req.market_spread),
        difference_from_range_centre: r1(mid - num(req.market_spread)),
        statement: 'MODEL, PLAYER QUALITY, SCHEME and SIMULATION are computed without the market. Agreement between them is agreement between EdgeDesk’s own layers — it is research agreement, NOT proof of an edge.' }
    };
  }

  /* --------------------------------------------------------------------
     WHAT BREAKS THE PROJECTION
     Deterministic sensitivity: shift one input by one standard deviation of
     its own measured spread and recompute the MEAN, exactly. No re-simulation,
     so the answer is not noise.
     -------------------------------------------------------------------- */
  function sensitivity(req) {
    var base = num(req.spread);
    if (base == null) return { available: false, reason: 'no baseline spread to perturb' };
    var P = req.params || {}, cal = P.calibration || {};
    var pc = cal.player_points_per_unit;
    var applied = !!(pc && pc.points_applied === true);
    var sdUnit = num(req.unit_sd) || 12;      /* one SD of a unit rating, by construction */
    var probes = CFG.SIMULATION.sensitivity, out = [], i;
    var groups = req.groups || {};
    for (i = 0; i < probes.length; i++) {
      var p = probes[i];
      var moved = movement(p, req, sdUnit, pc, groups);
      out.push({
        id: p.id, label: p.label, side: p.side,
        spread: moved.delta == null ? null : r1(base + moved.delta),
        delta: moved.delta == null ? null : r1(moved.delta),
        applied: applied && moved.delta != null,
        basis: moved.basis,
        reason: moved.delta == null ? moved.basis : null
      });
    }
    out.sort(function (a, b) { return Math.abs(b.delta || 0) - Math.abs(a.delta || 0); });
    return { available: true, baseline: r1(base), probes: out,
      units_note: applied
        ? 'each row moves ONE input by one standard deviation of its own measured spread and recomputes the mean exactly'
        : 'the player-quality scalar is not applied, so these rows report the SIZE of each shift in matchup points and deliberately do not restate the spread. A sensitivity built on an uncalibrated scalar would be theatre.' };
  }
  function movement(p, req, sdUnit, pc, groups) {
    var k = (pc && pc.points_applied === true) ? pc.value : null;
    var sign = p.side === 'fav' ? (req.favourite === 'home' ? 1 : -1)
      : p.side === 'dog' ? (req.favourite === 'home' ? -1 : 1) : 1;
    var pv = CFG.POSITION_VALUE;
    function unitShift(group, sds) {
      if (k == null) return { delta: null, basis: 'no calibrated points-per-unit scalar, so this shift is reported in matchup points only' };
      var share = (pv[group] || 0.3) / sumPositionValue();
      return { delta: sds * sdUnit * share * k * sign,
        basis: 'a ' + Math.abs(sds) + ' SD move in the ' + group + ' unit, weighted by that group’s share of team position value' };
    }
    if (p.target === 'qb') return unitShift('QB', p.sd);
    if (p.target === 'run_off') return unitShift('RB', p.sd);
    if (p.target === 'ol_starter_out') {
      var ol = groups[p.side === 'fav' ? 'fav_ol' : 'dog_ol'];
      if (ol == null) return { delta: null, basis: 'no offensive-line rating for that side, so the loss of a starter cannot be priced' };
      return unitShift('OL', -0.55);
    }
    if (p.target === 'qb_out') {
      var qb = groups[p.side === 'fav' ? 'fav_qb_drop' : 'dog_qb_drop'];
      if (qb == null) return { delta: null, basis: 'the drop from QB1 to QB2 is not known for that side (the room has no second rateable quarterback), so it is not priced' };
      if (k == null) return { delta: null, basis: 'no calibrated scalar' };
      return { delta: -qb * ((CFG.POSITION_VALUE.QB) / sumPositionValue()) * k * sign,
        basis: 'the measured EPIR gap between the projected starter and the next quarterback in the room' };
    }
    if (p.target === 'pace') return { delta: null,
      basis: 'pace changes the number of possessions, which widens the distribution rather than moving the mean. The simulator reads it; the mean does not.' };
    return { delta: null, basis: 'no mapping for this probe' };
  }
  var _pvSum = null;
  function sumPositionValue() {
    if (_pvSum != null) return _pvSum;
    var s = 0, list = CFG.OFFENSE_GROUPS.concat(CFG.DEFENSE_GROUPS), i;
    for (i = 0; i < list.length; i++) s += CFG.POSITION_VALUE[list[i]] || 0;
    _pvSum = s;
    return s;
  }

  /* --------------------------------------------------------------------
     WHY THIS COULD STAY CLOSE / WHY IT COULD BLOW OUT
     Template sentences over MEASURED facts. Every line names the number it
     came from. No language model writes, ranks or edits any of it — an AI may
     read these lines back to a user, it may not produce them.
     -------------------------------------------------------------------- */
  function structure(matchup, sim, opts) {
    opts = opts || {};
    var close = [], blow = [], i;
    var favSide = sim && sim.favourite;
    var favName = favSide === 'home' ? matchup.home : (favSide === 'away' ? matchup.away : null);
    var dogName = favSide === 'home' ? matchup.away : (favSide === 'away' ? matchup.home : null);
    var gates = matchup.run_defence_gate || {};

    /* the underdog's paths */
    var dogGateAgainst = favSide === 'home' ? gates.home : gates.away;
    if (dogGateAgainst && dogGateAgainst.available && ['QUESTIONABLE', 'FRAGILE', 'SEVERE MISMATCH'].indexOf(dogGateAgainst.state) >= 0) {
      close.push({ text: favName + '’s run defence grades ' + dogGateAgainst.state + ' (' + dogGateAgainst.score + '/100) against this opponent’s run game — a game the underdog can shorten is a game with fewer possessions and more variance',
        evidence: 'run defence gate', value: dogGateAgainst.score });
    }
    for (i = 0; i < (matchup.scheme_edges || []).length; i++) {
      var e = matchup.scheme_edges[i];
      if (!e.available || e.confidence < 0.25) continue;
      var favours = e.favours;
      if (favours === dogName && Math.abs(e.magnitude) >= 3.5) {
        close.push({ text: dogName + ' owns the ' + e.label.toLowerCase() + ' matchup by ' + Math.abs(e.magnitude) + ' matchup points (' + e.band + ')',
          evidence: e.id, value: e.magnitude });
      }
      if (favours === favName && Math.abs(e.magnitude) >= 7) {
        blow.push({ text: favName + ' owns the ' + e.label.toLowerCase() + ' matchup by ' + Math.abs(e.magnitude) + ' matchup points (' + e.band + ')',
          evidence: e.id, value: e.magnitude });
      }
    }
    /* quarterback certainty cuts both ways and is the loudest single input */
    for (i = 0; i < (matchup.risk_gates || []).length; i++) {
      var g = matchup.risk_gates[i];
      if (g.unobservable) continue;
      if (g.id === 'NEW_QB' && g.team === favName) close.push({ text: favName + '’s quarterback is the least certain input on the board — ' + g.detail, evidence: 'risk gate', value: null });
      if (g.id === 'NEW_QB' && g.team === dogName) blow.push({ text: dogName + '’s quarterback is the least certain input on the board — ' + g.detail, evidence: 'risk gate', value: null });
      if (g.id === 'SECONDARY_EXPLOSIVE_RISK' && g.team === favName) close.push({ text: favName + '’s secondary allows explosive passes at ' + g.detail, evidence: 'risk gate', value: null });
      if (g.id === 'SECONDARY_EXPLOSIVE_RISK' && g.team === dogName) blow.push({ text: dogName + '’s secondary allows explosive passes at ' + g.detail, evidence: 'risk gate', value: null });
      if (g.id === 'LOW_DEPTH' && g.team === dogName) blow.push({ text: dogName + ' is thin where it can least afford to be — ' + g.detail, evidence: 'risk gate', value: null });
    }
    /* depth advantage: a real blow-out mechanism and fully measured */
    var dq = opts.depth || null;
    if (dq && dq.fav != null && dq.dog != null && dq.fav - dq.dog >= 6) {
      blow.push({ text: favName + ' carries a ' + Math.round((dq.fav - dq.dog) * 10) / 10 + '-point depth-quality advantage across its units, which shows up late in games and in attrition',
        evidence: 'depth quality', value: dq.fav - dq.dog });
    }
    if (sim && sim.one_score_prob != null && sim.one_score_prob >= 0.28) {
      close.push({ text: 'the simulated distribution itself puts ' + Math.round(sim.one_score_prob * 100) + '% of outcomes inside one score',
        evidence: 'simulation', value: sim.one_score_prob });
    }
    if (sim && sim.blowout_prob != null && sim.blowout_prob >= 0.35) {
      blow.push({ text: 'the simulated distribution puts ' + Math.round(sim.blowout_prob * 100) + '% of outcomes at 21 points or more',
        evidence: 'simulation', value: sim.blowout_prob });
    }
    if (!close.length) close.push({ text: 'nothing measurable in this matchup argues for a close game beyond ordinary football variance', evidence: null, value: null });
    if (!blow.length) blow.push({ text: 'nothing measurable in this matchup argues for a blow-out beyond ordinary football variance', evidence: null, value: null });
    return {
      why_close: close.slice(0, 5), why_blowout: blow.slice(0, 5),
      most_important: matchup.most_important,
      statement: 'Every line above is a template filled with a measured number and names the measurement it came from. No language model produced, ranked or edited any of it.'
    };
  }

  return { SCHEMA: SCHEMA, simulate: simulate, ladder: ladder, sensitivity: sensitivity,
    structure: structure, mulberry32: mulberry32, buildCdf: buildCdf, sampleCdf: sampleCdf,
    quantile: quantile, config: CFG };
});

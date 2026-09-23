/* ===========================================================================
   EdgeDesk game research contract — ONE structured object per game.

   Every research surface (the terminal's game card, the Collective's market
   page, the AI desk, exports) should read a game through this object rather
   than re-deriving a gap, a CLV or an EV of its own. The builder is pure: it
   takes already-captured facts and returns the contract. It never fetches,
   never fills a missing value, and never turns a spread gap into a
   probability.

   Depends on lib/research_core.js (and lib/research_eval.js when historical
   rows are supplied). Browser: window.EDGameResearch.build(input).

   INPUT (every field optional except game; missing stays missing)
     game:     {sport, season, week, game_id, home, away, kickoff_at, venue, status}
     now:      ISO — the moment "fresh" and "stale" are judged against
     model:    {model_id, version, data_version, captured_at,
                home_line,               EdgeDesk fair HOME line (neg = home fav)
                  — or engine: the raw engine output (projectGame), whose
                    margin-convention numbers are converted here, by name
                total, home_win_prob, sigma, sigma_source,
                cover_at: function(homeLine) -> {win, push, lose} for HOME,
                          the model's OWN distribution, or absent}
     market:   {open:{line, captured_at, source},
                current:{line, captured_at, source},       consensus home line
                close:{line, total, captured_at, source},
                total:{line, captured_at},
                moneyline:{home, away, captured_at, source},   American prices
                books:[{book, line, price_home, price_away, captured_at}],
                history:[{at, line}]}                        consensus path
     model_history: [{at, home_line}]    EdgeDesk fair line over time
     collective: [{model_id, name, creator, home_line, home_win_prob,
                   line_at_submission, received_at}]
     correlation: output of EDResearchEval.modelCorrelation, or absent
     quality:  {category: {available, partial, captured_at, max_age_h, note, source}}
     history:  {rows: evaluated rows for THIS model (EDResearchEval.evaluate)}
     result:   {home_score, away_score, final}
     scenarios: [{label, home_line, affected:[keys], supported:true}]
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var R = require('./research_core.js'), E = null;
    try { E = require('./research_eval.js'); } catch (e) { E = null; }
    module.exports = factory(R, E);
  } else root.EDGameResearch = factory(root.EDResearch, root.EDResearchEval || null);
})(typeof self !== 'undefined' ? self : this, function (R, E) {
  'use strict';
  if (!R) throw new Error('game_research needs research_core loaded first');
  var G = { version: 'game_research/1' };
  var num = R.num, round = R.round;

  function ms(iso) { if (!iso) return null; var t = new Date(iso).getTime(); return isFinite(t) ? t : null; }
  function ageHours(iso, now) {
    var a = ms(iso), b = ms(now);
    return (a == null || b == null) ? null : (b - a) / 3600000;
  }
  /* A number with where it came from. `value` null means unavailable. */
  function fact(value, source, capturedAt, rule, extra) {
    var o = { value: value == null ? null : value, source: source || null,
      captured_at: capturedAt || null, rule: rule || null };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    return o;
  }
  G.fact = fact;

  /* ------------------------------------------------------------ freshness */
  G.FRESH_HOURS = { market: 6, injuries: 48, starters: 96, qb: 96, weather: 24,
    team_ratings: 192, efficiency: 192, player_quality: 336, coaching: 2160,
    model_inputs: 192, scores: 12 };
  G.QUALITY_CATEGORIES = ['market', 'scores', 'injuries', 'starters', 'qb', 'weather',
    'team_ratings', 'efficiency', 'player_quality', 'coaching', 'model_inputs'];
  G.qualityStatus = function (entry, category, now) {
    if (!entry || entry.available === false) return 'UNAVAILABLE';
    if (entry.available == null && !entry.captured_at) return 'UNAVAILABLE';
    var limit = entry.max_age_h != null ? entry.max_age_h : G.FRESH_HOURS[category];
    var age = ageHours(entry.captured_at, now);
    if (limit != null && age != null && age > limit) return 'STALE';
    if (entry.partial) return 'PARTIAL';
    return 'AVAILABLE';
  };
  /* Categories and a completeness figure that explains itself: every point
     lost is attributed to a named category and status. */
  G.QUALITY_CREDIT = { AVAILABLE: 1, PARTIAL: 0.5, STALE: 0.5, UNAVAILABLE: 0 };
  G.dataQuality = function (quality, now, applicable) {
    var cats = applicable || G.QUALITY_CATEGORIES;
    var rows = cats.map(function (c) {
      var e = quality && quality[c];
      var st = G.qualityStatus(e, c, now);
      return { category: c, status: st, captured_at: (e && e.captured_at) || null,
        age_hours: e ? round(ageHours(e.captured_at, now), 1) : null,
        source: (e && e.source) || null, note: (e && e.note) || null,
        credit: G.QUALITY_CREDIT[st] };
    });
    var credit = rows.reduce(function (s, r) { return s + r.credit; }, 0);
    return {
      categories: rows,
      completeness: rows.length ? credit / rows.length : null,
      rule: 'completeness = mean credit over ' + rows.length + ' categories (AVAILABLE 1, PARTIAL 0.5, STALE 0.5, UNAVAILABLE 0)',
      missing: rows.filter(function (r) { return r.status === 'UNAVAILABLE'; }).map(function (r) { return r.category; }),
      stale: rows.filter(function (r) { return r.status === 'STALE'; }).map(function (r) { return r.category; }),
      partial: rows.filter(function (r) { return r.status === 'PARTIAL'; }).map(function (r) { return r.category; })
    };
  };

  /* ----------------------------------------------------- model, normalised
     Accepts either an already home-line model or a raw engine projection. */
  G.modelFrom = function (model) {
    if (!model) return null;
    var eng = model.engine || null;
    var line = num(model.home_line);
    var total = num(model.total), hwp = num(model.home_win_prob), sigma = num(model.sigma);
    var sigmaSource = model.sigma_source || null;
    var components = null;
    if (eng && eng.model) {
      if (line == null) line = R.homeLineFromEngineFairSpread(eng.model.fair_spread);
      if (total == null) total = num(eng.model.fair_total);
      if (hwp == null) hwp = num(eng.model.home_win_prob);
      if (sigma == null && num(eng.model.sigma_margin) != null) {
        sigma = num(eng.model.sigma_margin);
        sigmaSource = sigmaSource || 'engine per-game margin sigma (fitted residual distribution)';
      }
      components = G.decompose(eng);
    }
    return {
      model_id: model.model_id || (eng && eng.engine) || null,
      version: model.version || (eng && eng.model_version) || null,
      data_version: model.data_version || (eng && eng.feature_version) || null,
      captured_at: model.captured_at || (eng && eng.prediction_timestamp) || null,
      home_line: line, total: total, home_win_prob: hwp,
      sigma: sigma, sigma_source: sigmaSource,
      confidence: eng && eng.scores ? num(eng.scores.confidence) : num(model.confidence),
      p10_margin: eng && eng.model ? num(eng.model.p10_margin) : null,
      p90_margin: eng && eng.model ? num(eng.model.p90_margin) : null,
      decomposition: components,
      cover_at: typeof model.cover_at === 'function' ? model.cover_at : null,
      engine_cover: eng && eng.cover && eng.market && num(eng.market.spread_line) != null
        ? { home_line: R.homeLineFromEngineFairSpread(eng.market.spread_line), win: num(eng.cover.win),
            push: num(eng.cover.push), lose: num(eng.cover.lose), basis: eng.cover.basis || null } : null
    };
  };

  /* ---------------------------------------------- fair-line decomposition
     The CFB P4 engine's spread IS an additive sum of named terms (engine.js
     `fairSpread += pts(terms[i].m)`), so this decomposition is EXACT, not an
     attribution. Each term is converted onto the home line. `exact` is
     verified, not assumed: the terms must sum to the published number. */
  G.decompose = function (eng) {
    if (!eng || !eng.contributions || !eng.model) return null;
    var rows = eng.contributions.map(function (c) {
      var pts = num(c.points);
      return {
        key: c.key, label: c.label || c.key,
        value: pts == null ? null : R.homeLineFromEngineFairSpread(pts),
        available: !!c.available, missing: !c.available,
        reliability: c.confidence == null ? null : num(c.confidence),
        source: c.source || null, basis: c.basis || null, reason: c.reason || null
      };
    });
    var sum = rows.reduce(function (s, r) { return s + (r.value == null ? 0 : r.value); }, 0);
    var fair = R.homeLineFromEngineFairSpread(eng.model.fair_spread);
    var totals = (eng.total_contributions || []).map(function (c) {
      return { key: c.key, label: c.label || c.key, value: num(c.points), available: !!c.available,
        source: c.source || null, reason: c.reason || null };
    });
    return {
      method: 'exact additive terms from the engine',
      exact: fair != null && Math.abs(sum - fair) < 0.01,
      home_line: fair, sum: round(sum, 4), components: rows,
      /* weather moves the TOTAL in this engine, not the spread */
      total_components: totals
    };
  };

  /* --------------------------------------------------------------- market */
  G.lineShopping = function (books, consensusLine) {
    var list = (books || []).filter(function (b) { return b && num(b.line) != null; });
    if (!list.length) return { available: false, reason: 'no per-book quotes on file', books: [] };
    var lines = list.map(function (b) { return num(b.line); });
    /* HOME wants the highest home line (fewest points laid / most taken);
       AWAY wants the lowest home line. Ties broken by the better price. */
    function better(side, a, b) {
      var la = num(a.line), lb = num(b.line);
      if (la !== lb) return side === 'home' ? la > lb : la < lb;
      var pa = R.americanToDecimal(side === 'home' ? a.price_home : a.price_away);
      var pb = R.americanToDecimal(side === 'home' ? b.price_home : b.price_away);
      return (pa || 0) > (pb || 0);
    }
    function pick(side, best) {
      var out = list[0];
      for (var i = 1; i < list.length; i++) {
        if (best ? better(side, list[i], out) : better(side, out, list[i])) out = list[i];
      }
      return summarise(side, out);
    }
    function summarise(side, b) {
      var price = side === 'home' ? b.price_home : b.price_away;
      return { book: b.book, home_line: num(b.line), side_line: R.sideLine(b.line, side),
        price: num(price), break_even: R.breakEven(price), captured_at: b.captured_at || null };
    }
    /* best PRICE at the consensus number, kept apart from the best NUMBER:
       neither is "better" without weighing line against price */
    function bestPriceAt(side, line) {
      if (line == null) return null;
      var at = list.filter(function (b) { return num(b.line) === line; });
      if (!at.length) return null;
      var o = at[0];
      at.forEach(function (b) {
        var d = R.americanToDecimal(side === 'home' ? b.price_home : b.price_away);
        var od = R.americanToDecimal(side === 'home' ? o.price_home : o.price_away);
        if ((d || 0) > (od || 0)) o = b;
      });
      return summarise(side, o);
    }
    var primary = num(consensusLine);
    return {
      available: true, n_books: list.length,
      range: { min: Math.min.apply(null, lines), max: Math.max.apply(null, lines) },
      dispersion: R.sd(lines),
      best_number: { home: pick('home', true), away: pick('away', true) },
      worst_number: { home: pick('home', false), away: pick('away', false) },
      best_price_at_consensus: { line: primary, home: bestPriceAt('home', primary), away: bestPriceAt('away', primary) },
      books: list.map(function (b) {
        return { book: b.book, home_line: num(b.line), price_home: num(b.price_home), price_away: num(b.price_away),
          captured_at: b.captured_at || null };
      })
    };
  };

  /* --------------------------------------------------------- price-aware EV
     Only from the model's OWN cover probability at that exact line. With no
     such probability everything model-dependent is null and says why. */
  G.priceAtLine = function (model, side, homeLine, american) {
    var l = num(homeLine);
    var cov = null, basis = null;
    if (model && l != null) {
      if (model.cover_at) {
        try { cov = model.cover_at(l); basis = 'model distribution at this line'; } catch (e) { cov = null; }
      } else if (model.engine_cover && Math.abs(model.engine_cover.home_line - l) < 1e-9) {
        cov = model.engine_cover; basis = 'engine cover probability at the joined line';
      }
    }
    var p = null, push = null;
    if (cov && num(cov.win) != null) {
      p = side === 'home' ? num(cov.win) : num(cov.lose);
      push = num(cov.push) == null ? 0 : num(cov.push);
    }
    var a = R.priceAssessment(american, p, push);
    a.side = side; a.home_line = l; a.side_line = R.sideLine(l, side);
    a.push_prob = p == null ? null : push; a.basis = p == null ? null : basis;
    if (p == null && a.break_even != null) a.reason = 'no model cover probability at this line';
    return a;
  };

  /* --------------------------------------------------------- the builder */
  G.build = function (input) {
    input = input || {};
    var now = input.now || new Date().toISOString();
    var g = input.game || {};
    var mk = input.market || {};
    var model = G.modelFrom(input.model);
    var cur = mk.current || {}, open = mk.open || {}, close = mk.close || {};
    var curLine = num(cur.line), openLine = num(open.line), closeLine = num(close.line);
    var ml = mk.moneyline || {};
    var nv = R.noVigTwoWay(ml.home, ml.away);
    var mLine = model ? model.home_line : null;

    /* ---- model vs market */
    var gap = R.spreadGap(mLine, curLine);
    var z = (gap && model && model.sigma) ? gap.points / model.sigma : null;
    var mvm = {
      raw_gap: fact(gap ? gap.points : null, 'model home line - current consensus', cur.captured_at, '|model - market|'),
      side: gap ? gap.side : null,
      normalized_gap: fact(z == null ? null : round(z, 3), model ? model.sigma_source : null, model ? model.captured_at : null,
        'raw gap / model expected error (sigma)', { sigma: model ? model.sigma : null }),
      probability_gap: fact((model && model.home_win_prob != null && nv) ? model.home_win_prob - nv.a : null,
        'model home win prob - no-vig moneyline', ml.captured_at, 'multiplicative de-vig'),
      movement_since_open: (openLine != null && curLine != null && mLine != null) ? R.movementVsModel(mLine, openLine, curLine) : null,
      key_numbers_since_open: (openLine != null && curLine != null) ? R.keyNumberCrossings(openLine, curLine, g.sport) : null,
      clv_vs_close: null
    };
    if (closeLine != null && mLine != null) {
      var refLine = openLine != null ? openLine : null;
      var side = R.sideVsLine(mLine, refLine != null ? refLine : curLine);
      mvm.clv_vs_close = fact(refLine != null && side ? R.clvPoints(side, refLine, closeLine) : null,
        'open vs captured close, on the model side at open', close.captured_at, 'side-oriented CLV points');
    }

    /* ---- the market block */
    var shop = G.lineShopping(mk.books, curLine);
    var market = {
      open: fact(openLine, open.source, open.captured_at),
      current: fact(curLine, cur.source, cur.captured_at, 'consensus home line',
        { age_hours: round(ageHours(cur.captured_at, now), 1),
          stale: ageHours(cur.captured_at, now) != null && ageHours(cur.captured_at, now) > G.FRESH_HOURS.market }),
      close: fact(closeLine, close.source, close.captured_at),
      close_total: fact(num(close.total), close.source, close.captured_at),
      total: fact(num((mk.total || {}).line), (mk.total || {}).source, (mk.total || {}).captured_at),
      moneyline: { home: num(ml.home), away: num(ml.away), captured_at: ml.captured_at || null,
        no_vig_home: nv ? nv.a : null, no_vig_away: nv ? nv.b : null, overround: nv ? nv.overround : null },
      history: (mk.history || []).filter(function (h) { return h && num(h.line) != null; }),
      shopping: shop
    };

    /* ---- price-aware EV at the best number and at the consensus */
    var price = { home: null, away: null, note: null };
    if (model && shop.available) {
      ['home', 'away'].forEach(function (s) {
        var b = shop.best_number[s];
        price[s] = { best_number: G.priceAtLine(model, s, b.home_line, b.price),
          at_consensus: shop.best_price_at_consensus[s]
            ? G.priceAtLine(model, s, shop.best_price_at_consensus[s].home_line, shop.best_price_at_consensus[s].price) : null };
      });
    } else price.note = model ? 'no per-book prices on file' : 'no model projection';

    /* ---- collective */
    var col = (input.collective || []).filter(function (c) { return c && num(c.home_line) != null; });
    var agreement = R.agreement(col.map(function (c) { return { id: c.model_id, spread: c.home_line }; }), curLine);
    var members = col.map(function (c) {
      var others = col.filter(function (o) { return o !== c; }).map(function (o) { return o.home_line; });
      var cg = R.spreadGap(c.home_line, curLine);
      return {
        model_id: c.model_id, name: c.name || c.model_id, creator: c.creator || null,
        home_line: num(c.home_line), home_win_prob: num(c.home_win_prob),
        market_gap: cg ? cg.points : null, lean: cg ? cg.side : null,
        prob_gap: (num(c.home_win_prob) != null && nv) ? num(c.home_win_prob) - nv.a : null,
        line_at_submission: num(c.line_at_submission), received_at: c.received_at || null,
        movement: (num(c.line_at_submission) != null && curLine != null)
          ? R.movementVsModel(c.home_line, c.line_at_submission, curLine) : null,
        room: R.outlierStatus(c.home_line, others, curLine)
      };
    });
    var edRoom = (mLine != null && col.length >= 2)
      ? R.outlierStatus(mLine, col.map(function (c) { return c.home_line; }), curLine) : null;
    var corr = input.correlation || null;

    /* ---- history */
    var hist = null;
    if (E && input.history && input.history.rows && model) {
      var target = E.deriveRow({ model_id: model.model_id, sport: g.sport, game_id: g.game_id,
        kickoff_at: g.kickoff_at, predicted_at: model.captured_at, spread: mLine,
        line_at_prediction: curLine }, model.sigma ? { scale: model.sigma, n: null, method: 'sigma' } : null);
      var mine = input.history.rows.filter(function (r) { return r.model_id === model.model_id; });
      var bucketRows = mine.filter(function (r) { return r.edge_bucket === target.edge_bucket; });
      hist = {
        edge_bucket: target.edge_bucket, lead_bucket: target.lead_bucket,
        bucket: E.summarize(bucketRows),
        similar: E.similarSituations(target, mine, { minN: 10 })
      };
    }

    /* ---- data quality */
    var quality = G.dataQuality(input.quality, now, input.quality_categories);

    /* ---- postgame */
    var res = input.result || {};
    var autopsy = null;
    if (res.final && num(res.home_score) != null && num(res.away_score) != null) {
      var margin = num(res.home_score) - num(res.away_score);
      var pm = R.marginFromSpread(mLine), cm = R.marginFromSpread(closeLine);
      var sideOpen = R.sideVsLine(mLine, openLine != null ? openLine : curLine);
      autopsy = {
        final_margin: margin,
        model_home_line: mLine, close_home_line: closeLine,
        model_margin_error: pm == null ? null : round(Math.abs(pm - margin), 2),
        market_margin_error: cm == null ? null : round(Math.abs(cm - margin), 2),
        model_closer_than_market: (pm != null && cm != null) ? Math.abs(pm - margin) < Math.abs(cm - margin) : null,
        side: sideOpen,
        ats_vs_close: E && sideOpen && closeLine != null ? E.atsResult(margin, closeLine, sideOpen) : null,
        clv: mvm.clv_vs_close ? mvm.clv_vs_close.value : null,
        components: G.componentAutopsy(model && model.decomposition, input.actual_components)
      };
    }

    /* ---- scenarios: supplied by a caller that re-ran the model */
    var scenarios = (input.scenarios || []).filter(function (s) { return s && s.supported && num(s.home_line) != null; })
      .map(function (s) {
        return { label: s.label, hypothetical: true, baseline_home_line: mLine, scenario_home_line: num(s.home_line),
          difference: mLine == null ? null : round(num(s.home_line) - mLine, 2), affected: s.affected || [] };
      });

    var out = {
      contract: G.version,
      built_at: now,
      identity: { sport: g.sport || null, season: g.season == null ? null : g.season, week: g.week == null ? null : g.week,
        game_id: g.game_id || null, home: g.home || null, away: g.away || null,
        kickoff_at: g.kickoff_at || null, venue: g.venue || null, status: g.status || null },
      model: model ? {
        model_id: model.model_id, version: model.version, data_version: model.data_version,
        captured_at: model.captured_at,
        fair_home_line: fact(mLine, model.model_id, model.captured_at, 'home line; negative = home favoured'),
        projected_home_margin: R.marginFromSpread(mLine),
        projected_total: fact(model.total, model.model_id, model.captured_at),
        home_win_prob: fact(model.home_win_prob, model.model_id, model.captured_at),
        expected_error: fact(model.sigma, model.sigma_source, model.captured_at),
        interval_80: (model.p10_margin != null && model.p90_margin != null)
          ? { lo_margin: model.p10_margin, hi_margin: model.p90_margin } : null,
        confidence: model.confidence,
        decomposition: model.decomposition,
        cover_at_joined_line: model.engine_cover
      } : null,
      market: market,
      model_vs_market: mvm,
      price: price,
      collective: {
        n: agreement.n, agreement: agreement, members: members,
        edgedesk_room: edRoom,
        effective_independent: corr ? corr.effective_n : null,
        independence_note: corr ? (corr.effective_n == null ? 'insufficient shared history to measure independence' : null)
          : 'no correlation history supplied'
      },
      model_history: (input.model_history || []).filter(function (h) { return h && num(h.home_line) != null; }),
      history: hist,
      quality: quality,
      scenarios: scenarios,
      autopsy: autopsy
    };
    out.flags = G.researchFlags(out, now);
    return out;
  };

  /* Forecast vs measured, only for components with an ACTUAL on file. No
     measured actual means no statement about that component. */
  G.componentAutopsy = function (decomp, actuals) {
    if (!decomp || !decomp.components) return { available: false, reason: 'no decomposition' };
    if (!actuals) return { available: false, reason: 'no measured component outcomes on file; no component is blamed' };
    var rows = [];
    decomp.components.forEach(function (c) {
      var a = actuals[c.key];
      if (!a || num(a.value) == null || c.value == null) return;
      rows.push({ key: c.key, label: c.label, forecast: c.value, actual: num(a.value),
        miss: round(num(a.value) - c.value, 2), source: a.source || null });
    });
    rows.sort(function (x, y) { return Math.abs(y.miss) - Math.abs(x.miss); });
    return { available: rows.length > 0, rows: rows,
      reason: rows.length ? null : 'no component had both a forecast and a measured outcome' };
  };

  /* ------------------------------------------------------ research queue
     Transparent flags, each with the rule that raised it. `priority` is a
     count of raised flags for ordering a slate — it is NOT a probability,
     a rating or a recommendation. */
  G.FLAG_RULES = {
    LARGE_DISAGREEMENT: 'normalized gap >= 0.25 sigma, or raw gap >= 3 pts when no sigma',
    MARKET_TOWARD_MODEL: 'consensus moved >= 1 pt toward the model since open',
    MARKET_AWAY_FROM_MODEL: 'consensus moved >= 1 pt away from the model since open',
    KEY_NUMBER: 'consensus crossed or landed on a primary key number since open',
    MODEL_CONSENSUS: '3+ Collective models and at least 75% lean the same way as EdgeDesk',
    LONE_OUTLIER: 'EdgeDesk is the only model on its side of the market',
    HIGH_UNCERTAINTY: 'data completeness below 70% or any stale market/QB/injury category',
    PRICE_DISPERSION: 'books differ by 1+ point on the spread',
    STALE_MARKET: 'current consensus older than the market freshness window',
    NO_MARKET: 'no current market line'
  };
  G.researchFlags = function (o, now) {
    var f = [];
    function add(k, detail) { f.push({ key: k, rule: G.FLAG_RULES[k], detail: detail || null }); }
    var mv = o.model_vs_market;
    if (o.market.current.value == null) add('NO_MARKET');
    else if (o.market.current.stale) add('STALE_MARKET', o.market.current.age_hours + 'h old');
    var z = mv.normalized_gap.value, raw = mv.raw_gap.value;
    if ((z != null && z >= 0.25) || (z == null && raw != null && raw >= 3))
      add('LARGE_DISAGREEMENT', raw + ' pts' + (z != null ? ' / ' + z + ' sigma' : ''));
    var m = mv.movement_since_open;
    if (m && m.toward_model_points != null) {
      if (m.toward_model_points >= 1) add('MARKET_TOWARD_MODEL', m.toward_model_points + ' pts');
      else if (m.toward_model_points <= -1) add('MARKET_AWAY_FROM_MODEL', (-m.toward_model_points) + ' pts');
    }
    if ((mv.key_numbers_since_open || []).some(function (k) { return k.tier === 'primary' && k.kind !== 'off'; }))
      add('KEY_NUMBER', mv.key_numbers_since_open.map(function (k) { return k.kind + ' ' + k.key; }).join(', '));
    var c = o.collective;
    if (c.n >= 3 && mv.side) {
      var same = mv.side === 'home' ? c.agreement.lean.home : c.agreement.lean.away;
      if (same / c.n >= 0.75) add('MODEL_CONSENSUS', same + ' of ' + c.n + ' lean ' + mv.side);
    }
    if (c.edgedesk_room && c.edgedesk_room.lone) add('LONE_OUTLIER');
    var q = o.quality;
    if ((q.completeness != null && q.completeness < 0.7)
      || q.stale.some(function (k) { return k === 'market' || k === 'qb' || k === 'injuries'; }))
      add('HIGH_UNCERTAINTY', 'completeness ' + (q.completeness == null ? 'n/a' : Math.round(q.completeness * 100) + '%'));
    var sh = o.market.shopping;
    if (sh.available && sh.range.max - sh.range.min >= 1) add('PRICE_DISPERSION', (sh.range.max - sh.range.min) + ' pts across ' + sh.n_books + ' books');
    var research = f.filter(function (x) { return x.key !== 'NO_MARKET' && x.key !== 'STALE_MARKET'; }).length;
    return { flags: f, priority: research,
      priority_rule: 'count of research flags raised; ordering only, not a probability or a recommendation' };
  };

  return G;
});

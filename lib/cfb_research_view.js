/* ===========================================================================
   EdgeDesk CFB research view — ONE presentation object per college game.

   The question it answers is "what does a reader need to see first?", and it
   answers it ONLY from numbers the engine and the board have already
   produced. It is a presentation layer, nothing more:

     - it computes no projection. The raw margin, the win probability, the
       confidence, the cover probability and every stored number are the
       engine's (football/cfb_p4/engine.js projectGame) and are read, never
       recomputed or written back;
     - it fills nothing in. A value the game does not carry stays null and the
       view says it is unavailable; nothing is estimated to make a cell full;
     - every threshold lives in CONFIG below, each one either an existing
       EdgeDesk threshold (named where it comes from) or a presentation
       threshold of this layer (said so). The UI reads the result; it never
       re-derives a label, a gap or a side of its own.

   Browser: window.EDCfbResearchView. Node: require('./cfb_research_view.js').
   The adapter that assembles the input from page state lives in app.html
   (fbP4ViewFor), so this file never reads the page.

   CONVENTIONS
     margin      home perspective, + = home favoured by (engine fair_spread and
                 the board's market spread_line both use it)
     book line   what a sportsbook prints for a side: negative = favoured
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCfbResearchView = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var V = { version: 'cfb_research_view/1' };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    if (b) for (k in b) if (Object.prototype.hasOwnProperty.call(b, k) && b[k] != null) o[k] = b[k];
    return o;
  }

  /* ------------------------------------------------------------ the rules */
  V.CONFIG = {
    /* football/cfb_p4/engine.js fairLine.FLOOR — the engine decides the floor;
       this copy only lets a caller check the engine's display against it */
    near_pickem_floor: 1,
    /* EDCfbP4Params.market.min_research_gap: the engine's own research
       threshold (classifyEdge RESEARCH_LEAN, the card's REVIEW state) */
    research_gap: 2,
    /* where the board turns RESEARCH into INVESTIGATE (fbP4StatusFor) and the
       size at which the app already says missing information is the likelier
       explanation (fbTodayItems, lib/research_priority.js ELEVATED_GAP) */
    major_gap: 7,
    /* FB_GUARD.p4.game: past it the board reads the gap as a DATA FAULT */
    guard_gap: 21,
    /* EDCfbP4Params.market.min_confidence: below it the engine refuses to
       lean at all (PASS_LOW_CONFIDENCE, the board's THIN DATA) */
    min_confidence: 35,
    /* the card's existing band for the same number (fbGxSummary colours
       data confidence ok at 60+, warn at 35+, neg below) */
    high_confidence: 60,
    /* football/matchup/packet.js: under 60% of the applicable input contract
       the research packet argues against the number */
    limited_coverage: 0.6,
    /* lib/research_priority.js STRONG_COVERAGE */
    strong_coverage: 0.85,
    /* WHY EDGEDESK LEANS — this layer's own presentation thresholds. A
       component under half a point is not a reason a reader should be given,
       and one the engine measured with under 0.2 confidence is not a
       reliable one. At most three reasons, market context included. */
    driver_min_points: 0.5,
    driver_min_confidence: 0.2,
    drivers_max: 3,
    /* PROJECTION MOVEMENT, in points of raw margin — this layer's own bands:
       under 0.75 is STABLE, 0.75 to 2 is MOVING, past 2 is SIGNIFICANT
       CHANGE. The same bands grade stability over the stored range. */
    move_stable: 0.75,
    move_significant: 2.0,
    /* a supplied injury report whose status ambiguity reaches this is
       structured availability uncertainty. 0.25 is what the engine's own
       arithmetic gives one game-time decision on a primary starter at the
       highest-weighted position (injuryImpact: 0.35 x 0.8 x 1). An ABSENT
       report is not uncertainty data and never reaches this rule. */
    injury_uncertainty_min: 0.25,
    /* the market moving: lib/research_priority.js MEANINGFUL_MOVE */
    line_move_pts: 1,
    line_move_pp: 3
  };
  V.config = function (over) { return merge(V.CONFIG, over); };

  /* --------------------------------------------------------- formatting */
  /* "Ole Miss -6.5": a side and the book line it lays */
  function laying(team, pts, dp) { return team + ' -' + Math.abs(pts).toFixed(dp == null ? 1 : dp); }
  V.format = { laying: laying };

  /* ================================================ STEP 1: THE FAIR LINE
     The engine publishes the raw margin (model.fair_spread) and, beside it,
     the line a reader is shown (model.display_fair_spread): the same number,
     except that a near pick'em (|raw| < 1) is shown at a one-point floor on
     the side the model measurably favours, with an exact tie broken by the
     engine's own deterministic hierarchy (fairLine.tiebreak). This reads
     those fields; it does not re-derive them. A model that publishes no
     display line shows its raw number, exactly as fbFairDisp() does. */
  V.fairLine = function (p, game) {
    if (!p || p.status !== 'PREDICTED' || !p.model || num(p.model.fair_spread) == null) return null;
    var m = p.model, raw = m.fair_spread;
    var home = (game && game.home) || (p.game && p.game.home) || 'Home';
    var away = (game && game.away) || (p.game && p.game.away) || 'Away';
    var disp = num(m.display_fair_spread) != null ? m.display_fair_spread : raw;
    var side = (m.display_side === 'home' || m.display_side === 'away') ? m.display_side
      : (disp > 0 ? 'home' : (disp < 0 ? 'away' : null));
    var near = m.is_near_pickem === true;
    var fav = side === 'home' ? home : (side === 'away' ? away : null);
    var dog = side === 'home' ? away : (side === 'away' ? home : null);
    /* the RAW margin, stated for the side the display names (>= 0 unless the
       engine's tiebreak named a side on an exact tie, where it is 0) */
    var favMargin = side === 'away' ? -raw : raw;
    if (favMargin === 0) favMargin = 0;           /* no "-0" */
    return {
      raw_projected_margin: raw,
      display_fair_spread: disp,
      display_side: side,
      favorite_team: fav,
      underdog_team: dog,
      is_near_pickem: near,
      raw_favorite_margin: favMargin,
      fair_line_text: fav ? laying(fav, disp) : (home + ' ' + (disp === 0 ? '0.0' : (-disp > 0 ? '+' : '') + (-disp).toFixed(1))),
      raw_line_text: fav ? (favMargin === 0 ? fav + ' ±0.00 (an exact tie before the tiebreak)' : laying(fav, favMargin, 2)) : null,
      basis: m.display_basis || null
    };
  };

  /* ================================================ STEP 2: THE MARKET GAP
     How far EdgeDesk's number is from the market's, and toward which team.

       signed = raw margin - market margin           (home perspective)
              = (market book line) - (EdgeDesk book line), for the home side

     which is exactly the engine's own market.spread_gap. Positive: EdgeDesk
     likes the HOME side more than the market does; negative: the AWAY side.
     It is measured from the RAW margin, never from the one-point display
     floor, so a near pick'em can never manufacture a gap by rounding. */
  function marketLineText(line, home, away) {
    if (line === 0) return 'Pick’em';
    return line > 0 ? laying(home, line) : laying(away, line);
  }
  V.marketGap = function (fl, market, game) {
    var home = (game && game.home) || 'Home', away = (game && game.away) || 'Away';
    var line = market ? num(market.spread_line) : null;
    if (!fl || line == null) {
      return { available: false, market_spread: line,
        reason: !fl ? 'no EdgeDesk projection to compare'
          : (market && market.spread_fault ? 'the market line was dropped: it only agreed with the model in the opposite spread convention'
            : 'no market line is joined to this game') };
    }
    var signed = fl.raw_projected_margin - line;
    var pts = Math.abs(signed);
    var toward = signed > 0 ? 'home' : (signed < 0 ? 'away' : null);
    var towardTeam = toward === 'home' ? home : (toward === 'away' ? away : null);
    var marketFav = line > 0 ? 'home' : (line < 0 ? 'away' : null);
    var aligned = Math.round(pts * 10) === 0;
    return {
      available: true,
      market_spread: line,
      market_line_text: marketLineText(line, home, away),
      market_favorite: marketFav === 'home' ? home : (marketFav === 'away' ? away : null),
      signed: signed,
      points: pts,
      toward: aligned ? null : toward,
      toward_team: aligned ? null : towardTeam,
      /* EdgeDesk and the market name different favourites */
      favorite_differs: !!(marketFav && fl.display_side && marketFav !== fl.display_side),
      text: aligned ? '0.0 pts — EdgeDesk matches the market' : pts.toFixed(1) + ' pts toward ' + towardTeam,
      measured_from: 'raw',
      note: fl.is_near_pickem
        ? 'Measured from the raw margin (' + fl.raw_line_text + '), not from the one-point display line.'
        : null,
      source: (market && market.book) || null,
      as_of: (market && market.as_of) || null,
      stale: !!(market && market.stale)
    };
  };

  /* ============================== CONFIDENCE AND RELIABILITY — two numbers
     Neither is computed here. They answer different questions, and neither
     is the size of the market gap:

       CONFIDENCE   the engine's information confidence (scores.confidence,
                    0-100: "how good is my information?", weighted by how
                    much each input matters), as a tier on the engine's own
                    floor (35) and the card's existing band (60)
       RELIABILITY  the input-contract coverage (fbP4Contract summary
                    input_coverage): the share of this game's applicable
                    inputs EdgeDesk actually has on file today

     A large gap with a Low confidence and a 50% reliability is a different
     object from a large gap with High and 90%, and the view keeps them apart
     so a reader cannot mistake one for the other. */
  V.TIER_LABEL = { HIGH: 'High', MODERATE: 'Moderate', LOW: 'Low' };
  V.confidence = function (p, cfg) {
    cfg = cfg || V.CONFIG;
    var s = p && p.scores ? num(p.scores.confidence) : null;
    var tier = s == null ? null : (s < cfg.min_confidence ? 'LOW' : (s < cfg.high_confidence ? 'MODERATE' : 'HIGH'));
    return {
      score: s, tier: tier,
      label: tier ? V.TIER_LABEL[tier] : 'Unavailable',
      pct_text: s == null ? null : Math.round(s) + '%',
      priced: p && p.scores ? num(p.scores.confidence_priced) : null,
      basis: 'the engine’s information confidence: how good EdgeDesk’s inputs for this game are, weighted by how much each one matters'
    };
  };
  V.reliability = function (coverage, cfg) {
    cfg = cfg || V.CONFIG;
    var v = coverage ? num(coverage.input_coverage) : null;
    var tier = v == null ? null : (v < cfg.limited_coverage ? 'LOW' : (v < cfg.strong_coverage ? 'ADEQUATE' : 'STRONG'));
    var known = coverage ? num(coverage.known) : null, app = coverage ? num(coverage.applicable) : null;
    return {
      value: v, tier: tier,
      pct: v == null ? null : Math.round(v * 100),
      text: v == null ? 'Unavailable' : Math.round(v * 100) + '%',
      known: known, applicable: app,
      sub: (known != null && app != null) ? (known + ' of ' + app + ' inputs on file') : 'input coverage not reported',
      basis: 'the share of this game’s applicable inputs EdgeDesk has on file (the input contract), counted, not weighted'
    };
  };

  /* ========================================= STEP 3: ONE RESEARCH LABEL
     Exactly one label per game, from one function, everywhere. The rules are
     checked in this order and the first that holds wins:

       LIMITED DATA        no valid projection
       LOW RELIABILITY     the gap is past the guard bound (a data fault is the
                           likelier read than a disagreement about football)
       LIMITED DATA        confidence unmeasured, or under the engine's floor
       LOW RELIABILITY     reliability unmeasured, or under the limited bar
       LIMITED DATA        no current market line (none, dropped or stale)
       NEAR PICK'EM        EdgeDesk names a side, with under a point under it
       MAJOR DISAGREEMENT  gap at the INVESTIGATE size or more
       WORTH RESEARCHING   gap at the research threshold or more
       MARKET ALIGNED      inside the research threshold

     None of them is a pick, and nothing here is ever called one. */
  V.LABELS = {
    LIMITED_DATA: { label: 'LIMITED DATA', tone: 'mut' },
    LOW_RELIABILITY: { label: 'LOW RELIABILITY', tone: 'neg' },
    NEAR_PICKEM: { label: 'NEAR PICK’EM', tone: 'gold' },
    MAJOR_DISAGREEMENT: { label: 'MAJOR DISAGREEMENT', tone: 'warn' },
    WORTH_RESEARCHING: { label: 'WORTH RESEARCHING', tone: 'accent' },
    MARKET_ALIGNED: { label: 'MARKET ALIGNED', tone: 'ok' }
  };
  V.LABEL_KEYS = ['LIMITED_DATA', 'LOW_RELIABILITY', 'NEAR_PICKEM', 'MAJOR_DISAGREEMENT', 'WORTH_RESEARCHING', 'MARKET_ALIGNED'];
  function lab(key, rule, means) {
    return { key: key, label: V.LABELS[key].label, tone: V.LABELS[key].tone, rule: rule, means: means };
  }
  V.researchLabel = function (x, cfg) {
    cfg = cfg || V.CONFIG;
    var fl = x.fair, g = x.market_gap || { available: false }, c = x.confidence || {}, r = x.reliability || {};
    if (!fl)
      return lab('LIMITED_DATA', 'not_projected', 'EdgeDesk has no valid projection for this game'
        + (x.projection_status ? ' (' + String(x.projection_status).replace(/_/g, ' ').toLowerCase() + ')' : '')
        + ', so there is nothing to compare with the market.');
    if (g.available && g.points > cfg.guard_gap)
      return lab('LOW_RELIABILITY', 'guard', 'EdgeDesk and the market are ' + g.points.toFixed(1) + ' points apart, past the '
        + cfg.guard_gap + '-point guard bound. At that size a data fault — a missing starter, a mis-joined line — is the likelier '
        + 'explanation than a disagreement about football. Treat EdgeDesk’s number as unsafe until the gap is explained.');
    if (c.score == null)
      return lab('LIMITED_DATA', 'confidence_unmeasured', 'The engine could not measure its own information confidence for this game. '
        + 'An unmeasured confidence is treated as thin, never as healthy.');
    if (c.score < cfg.min_confidence)
      return lab('LIMITED_DATA', 'thin', 'EdgeDesk’s information confidence is ' + Math.round(c.score) + '%, under the '
        + cfg.min_confidence + '% floor the engine needs before it will lean either way. Read the number as provisional.');
    if (r.value == null)
      return lab('LOW_RELIABILITY', 'coverage_unmeasured', 'EdgeDesk could not count which of this game’s inputs it has on file, '
        + 'so the projection’s reliability is unknown. Unknown is not treated as complete.');
    if (r.value < cfg.limited_coverage)
      return lab('LOW_RELIABILITY', 'coverage', 'Only ' + r.pct + '% of this game’s applicable inputs are on file'
        + (r.known != null && r.applicable != null ? ' (' + r.known + ' of ' + r.applicable + ')' : '')
        + ', under the ' + Math.round(cfg.limited_coverage * 100) + '% bar below which EdgeDesk argues against its own number.');
    if (!g.available)
      return lab('LIMITED_DATA', 'no_market', 'There is no current market line to compare with: ' + g.reason + '. '
        + 'The projection stands on its own until a quote lands.');
    if (g.stale)
      return lab('LIMITED_DATA', 'stale_market', 'The only market number on file is a stale capture, so any gap is measured '
        + 'against a price that may no longer exist.');
    if (fl.is_near_pickem)
      return lab('NEAR_PICKEM', 'near_pickem', 'EdgeDesk names ' + fl.favorite_team + ', but the raw margin under that line is '
        + Math.abs(fl.raw_favorite_margin).toFixed(2) + ' points: a side, with no real separation between the teams. '
        + 'The market gap is ' + g.text + '.');
    if (g.points >= cfg.major_gap)
      return lab('MAJOR_DISAGREEMENT', 'major_gap', 'EdgeDesk and the market are ' + g.text + ', at or past the '
        + cfg.major_gap + '-point size where missing information is more often the explanation than an edge. '
        + 'Open it to find what one side knows that the other does not.');
    if (g.points >= cfg.research_gap)
      return lab('WORTH_RESEARCHING', 'research_gap', 'EdgeDesk differs from the market by ' + g.text + ', past the '
        + cfg.research_gap + '-point research threshold, with usable confidence and reliability. '
        + 'A question worth opening — not a validated edge.');
    return lab('MARKET_ALIGNED', 'aligned', 'EdgeDesk and the market are ' + g.points.toFixed(1) + ' points apart, inside the '
      + cfg.research_gap + '-point research threshold: there is not enough disagreement to research the price.');
  };

  /* =================================== STEP 5: WHY EDGEDESK LEANS [TEAM]
     The largest measured reasons on the side the fair line names, read from
     the engine's own additive terms (projectGame contributions, which sum to
     the raw margin). Every reason is one term the engine priced, with its
     points; nothing is written that the engine did not measure, and no term
     appears twice. The market gap may close the list as CONTEXT — it is not
     a reason the model leans, and it is marked as such — only when it points
     the same way. Nothing here is generated: the words are fixed per term. */
  V.DRIVER_TEXT = {
    rating: 'team-strength edge (opponent-adjusted results)',
    hfa: 'home-field advantage',
    qb: 'quarterback matchup',
    matchup: 'stylistic matchup',
    travel: 'opponent travel burden',
    schedule: 'schedule-stress edge',
    injury: 'reported availability',
    rivalry: 'rivalry situational effect',
    conference: 'conference-strength edge'
  };
  V.leanReasons = function (p, fl, gap, game, cfg) {
    cfg = cfg || V.CONFIG;
    if (!fl || !fl.display_side) return null;
    var side = fl.display_side, home = side === 'home';
    var out = { team: fl.favorite_team, side: side, reasons: [], none: false, text: null,
      near_pickem: !!fl.is_near_pickem, rule: null };
    var ex = (p && p.explanation && p.explanation.primary_drivers) || [];
    var terms = ((p && p.contributions) || []).filter(function (c) {
      var pts = num(c && c.points);
      if (!c || !c.available || pts == null) return false;
      if ((pts > 0) !== home || pts === 0) return false;              /* on the lean's side only */
      if (Math.abs(pts) < cfg.driver_min_points) return false;
      if (num(c.confidence) != null && c.confidence < cfg.driver_min_confidence) return false;
      return true;
    });
    terms.sort(function (a, b) {
      var ka = String(a.key), kb = String(b.key);
      return (Math.abs(b.points) - Math.abs(a.points)) || (ka < kb ? -1 : (ka > kb ? 1 : 0));
    });
    var seen = {};
    terms.forEach(function (c) {
      if (seen[c.key] || out.reasons.length >= cfg.drivers_max) return;
      seen[c.key] = 1;
      var d = null, i;
      for (i = 0; i < ex.length; i++) if (ex[i] && ex[i].key === c.key) { d = ex[i]; break; }
      out.reasons.push({ kind: 'component', key: c.key, points: Math.abs(c.points),
        text: '+' + Math.abs(c.points).toFixed(1) + ' pts ' + (V.DRIVER_TEXT[c.key] || (c.label || c.key)),
        /* the engine's own sentence for this term, when it wrote one */
        detail: d ? d.text : null, confidence: num(c.confidence), source: c.source || null });
    });
    if (gap && gap.available && out.reasons.length < cfg.drivers_max
        && gap.points >= cfg.research_gap && gap.toward === side) {
      out.reasons.push({ kind: 'market', key: 'market_gap', points: gap.points,
        text: 'The market is ' + gap.points.toFixed(1) + ' pts away from EdgeDesk’s number, toward ' + fl.favorite_team
          + ' (market: ' + gap.market_line_text + ')', detail: 'context, not a model component', confidence: null, source: gap.source });
    }
    if (!out.reasons.length) {
      out.none = true;
      out.text = 'No single component is driving the projection.';
    }
    out.rule = 'the largest priced terms on ' + fl.favorite_team + '’s side, at least ' + cfg.driver_min_points
      + ' pts each, measured with ' + cfg.driver_min_confidence + '+ confidence; at most ' + cfg.drivers_max;
    return out;
  };

  /* ================================================ STEP 6: BEST AVAILABLE
     The best CURRENT number a named sportsbook is offering on each side,
     from captured quotes only. A quote is used only when:
       - it names a book and carries a line;
       - the page's own freshness policy called it actionable (app.html
         passes EDINTEL.quoteState — the same ladder capture enforces on the
         write side). A stale quote, or one whose age cannot be established,
         is the last price EdgeDesk saw, not a price that is available, and is
         excluded and counted;
     A missing price is shown as missing, never assumed. With one book there
     is no line shopping to speak of and the view says so rather than calling
     one quote "best". Nothing here is a consensus line: the board's own
     market number is quoted beside it under its own source.

     quote = {side:'home'|'away', book, line (that side's book line, e.g. -5.5
              or +7.5), price_dec, n_books, captured_at, state, actionable} */
  function american(dec) {
    dec = num(dec);
    if (dec == null || dec <= 1) return null;
    return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
  }
  function sideLine(v) { return v === 0 ? 'PK' : (v > 0 ? '+' : '') + v.toFixed(1); }
  V.american = american;
  V.bestAvailable = function (quotes, fl, gap, game, cfg) {
    cfg = cfg || V.CONFIG;
    var home = (game && game.home) || 'Home', away = (game && game.away) || 'Away';
    var all = (quotes || []).filter(Boolean);
    var excluded = { stale: 0, unverified: 0, no_line: 0, no_book: 0 };
    var valid = [];
    all.forEach(function (q) {
      if (q.side !== 'home' && q.side !== 'away') return;
      if (num(q.line) == null || Math.abs(q.line) > 70) { excluded.no_line++; return; }
      if (!q.book) { excluded.no_book++; return; }
      if (q.actionable !== true) {
        if (q.state === 'STALE') excluded.stale++; else excluded.unverified++;
        return;
      }
      valid.push(q);
    });
    var base = { available: false, excluded: excluded, n_quotes: all.length };
    if (!all.length) { base.reason = 'no sportsbook quote has been captured for this game'; return base; }
    if (!valid.length) {
      base.reason = excluded.stale && !excluded.unverified
        ? 'every captured quote is past its freshness limit, so none is shown as available'
        : (excluded.unverified ? 'the captured quotes carry no verifiable capture time, so none is shown as available'
          : 'no captured quote names both a book and a line');
      return base;
    }
    var books = {}, nb = 0;
    valid.forEach(function (q) { books[q.book] = 1; if (num(q.n_books) != null && q.n_books > nb) nb = q.n_books; });
    var nBooks = Math.max(Object.keys(books).length, nb);
    function best(side) {
      var list = valid.filter(function (q) { return q.side === side; });
      if (!list.length) return null;
      list.sort(function (a, b) {
        return (b.line - a.line)                                       /* more points for the taker */
          || ((num(b.price_dec) || 0) - (num(a.price_dec) || 0))      /* then the better price */
          || (String(a.book) < String(b.book) ? -1 : (String(a.book) > String(b.book) ? 1 : 0));
      });
      var q = list[0], am = american(q.price_dec), team = side === 'home' ? home : away;
      return { side: side, team: team, book: q.book, line: q.line, price_dec: num(q.price_dec), price_american: am,
        captured_at: q.captured_at || null, state: q.state || null,
        text: team + ' ' + sideLine(q.line) + (am != null ? ' (' + (am > 0 ? '+' : '') + am + ')' : ' (price not captured)')
          + ' at ' + q.book };
    }
    var out = { available: true, excluded: excluded, n_quotes: all.length, n_valid: valid.length, n_books: nBooks,
      single_book: nBooks < 2, home: best('home'), away: best('away') };
    /* the side EdgeDesk likes more than the market does, else the side it names */
    out.focus_side = (gap && gap.available && gap.toward) ? gap.toward : (fl ? fl.display_side : null);
    out.focus = out.focus_side ? out[out.focus_side] : null;
    if (!out.focus) out.focus = out.home || out.away;
    /* against the board's own number for the same side, under its own source */
    if (gap && gap.available && out.focus) {
      var boardSide = out.focus.side === 'home' ? -gap.market_spread : gap.market_spread;
      out.board_line = boardSide;
      out.board_source = gap.source;
      out.improvement = Math.round((out.focus.line - boardSide) * 10) / 10;
    }
    out.note = out.single_book
      ? 'Only one sportsbook has a current quote, so there is no line shopping to compare — this is that book’s number, not a best line.'
      : null;
    return out;
  };

  /* ======================== STEP 7: PROJECTION STATUS AND STABILITY
     Measured against EdgeDesk's OWN stored projections, never an estimate of
     one. The only prior numbers the page can read are the committed model
     record (record/football/cfb_<season>.json, written hourly by
     tools/record/football_record.js from the published slate): the FIRST
     pregame number and the LATEST changed one, each with its publication
     time, and how many revisions lie between them. Nothing in between is
     invented.

       previous   the latest stored number (the record's latest revision)
       change     current raw margin - previous; its size sets the status
       stability  the range of every stored number plus the current one

     So a projection that swung on Tuesday and has held since reads STABLE
     with LOW stability — both true, and both shown. Stability is metadata:
     it moves no projection. */
  function ms(t) { if (t == null) return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  /* a raw margin as a side line: two decimals under a point, so a near
     pick'em's raw history never reads "-0.0" */
  function marginText(m, home, away) {
    if (m === 0) return 'even (0.00)';
    var dp = Math.abs(m) < 1 ? 2 : 1;
    return m > 0 ? laying(home, m, dp) : laying(away, m, dp);
  }
  V.marginText = marginText;
  V.injuryUncertainty = function (p, cfg) {
    cfg = cfg || V.CONFIG;
    var L = p && p.layers && p.layers.injuries, out = { flagged: false, sides: [], players: [] };
    if (!L) return out;
    ['home', 'away'].forEach(function (s) {
      var u = L[s] && L[s].uncertainty;
      /* only a report that was SUPPLIED is uncertainty data */
      if (!u || !u.available || u.source !== 'injury status ambiguity' || num(u.value) == null) return;
      if (u.value < cfg.injury_uncertainty_min) return;
      out.flagged = true;
      out.sides.push({ side: s, value: u.value });
      (L[s].detail || []).forEach(function (d) {
        if (d && d.player && d.status) out.players.push({ side: s, player: d.player, position: d.position || null, status: d.status });
      });
    });
    return out;
  };
  V.STABILITY_LABEL = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
  V.STATUS = {
    LIMITED_DATA: { label: 'LIMITED DATA', tone: 'mut' },
    INJURY_UNCERTAINTY: { label: 'INJURY UNCERTAINTY', tone: 'warn' },
    SIGNIFICANT_CHANGE: { label: 'SIGNIFICANT CHANGE', tone: 'neg' },
    MOVING: { label: 'MOVING', tone: 'warn' },
    LINE_MOVING: { label: 'LINE MOVING', tone: 'accent' },
    STABLE: { label: 'STABLE', tone: 'ok' },
    NO_HISTORY: { label: 'NO HISTORY', tone: 'mut' }
  };
  function status(key, text) { return { key: key, label: V.STATUS[key].label, tone: V.STATUS[key].tone, text: text }; }
  V.projectionHistory = function (x, cfg) {
    cfg = cfg || V.CONFIG;
    var fl = x.fair, rec = x.record || null, now = ms(x.now) != null ? ms(x.now) : Date.now();
    var home = x.home || 'Home', away = x.away || 'Away';
    var out = { available: false, points: [], previous: null, change: null, since_first: null,
      revisions: rec && num(rec.revisions) != null ? rec.revisions : null,
      stability: { tier: null, range: null, n: 0, text: 'Unavailable: no earlier EdgeDesk number is stored for this game' },
      market_move: null, injury: V.injuryUncertainty(x.projection, cfg), status: null };
    function pt(o, source) {
      if (!o || num(o.margin) == null || ms(o.at) == null || ms(o.at) > now) return null;
      return { at: new Date(ms(o.at)).toISOString(), margin: o.margin, source: source, text: marginText(o.margin, home, away) };
    }
    var a = rec ? pt(rec.first, 'first published') : null, b = rec ? pt(rec.latest, 'latest published') : null;
    if (a) out.points.push(a);
    if (b && !(a && a.at === b.at)) out.points.push(b);
    out.points.sort(function (p, q) { return ms(p.at) - ms(q.at); });
    /* the market's own movement, from the same record and the same source */
    var me = rec && rec.market_entry, ml = rec && rec.market_latest;
    if (me && ml && num(me.margin) != null && num(ml.margin) != null && me.source && me.source === ml.source && me.at !== ml.at) {
      var mv = ml.margin - me.margin;
      out.market_move = { points: Math.abs(mv), toward_team: mv > 0 ? home : (mv < 0 ? away : null), since_at: me.at,
        source: me.source, text: Math.abs(mv).toFixed(1) + ' pts' + (mv ? ' toward ' + (mv > 0 ? home : away) : '') + ' (' + me.source + ')' };
    }
    var h2h = num(x.h2h_pp);
    out.h2h_pp = h2h;
    if (!fl) { out.status = status('LIMITED_DATA', 'There is no valid EdgeDesk projection to track.'); return out; }
    var cur = { at: new Date(now).toISOString(), margin: fl.raw_projected_margin, source: 'current',
      text: marginText(fl.raw_projected_margin, home, away) };
    if (out.points.length) {
      out.available = true;
      var prev = out.points[out.points.length - 1], first = out.points[0];
      out.previous = prev;
      var d = cur.margin - prev.margin;
      out.change = { signed: d, points: Math.abs(d), toward: d > 0 ? 'home' : (d < 0 ? 'away' : null),
        toward_team: d > 0 ? home : (d < 0 ? away : null), since_at: prev.at, since_source: prev.source,
        text: Math.abs(d) < 0.05 ? 'unchanged since the ' + prev.source + ' number'
          : Math.abs(d).toFixed(1) + ' pts toward ' + (d > 0 ? home : away) + ' since the ' + prev.source + ' number' };
      if (first !== prev) {
        var d1 = cur.margin - first.margin;
        out.since_first = { signed: d1, points: Math.abs(d1), toward_team: d1 > 0 ? home : (d1 < 0 ? away : null), since_at: first.at };
      }
      var all = out.points.map(function (p) { return p.margin; }).concat([cur.margin]);
      var range = Math.max.apply(null, all) - Math.min.apply(null, all);
      var tier = range < cfg.move_stable ? 'HIGH' : (range <= cfg.move_significant ? 'MEDIUM' : 'LOW');
      out.stability = { tier: tier, range: range, n: all.length,
        text: V.STABILITY_LABEL[tier] + ' · the stored numbers span ' + range.toFixed(1) + ' pts across ' + all.length + ' readings' };
    }
    out.points.push(cur);
    /* ---- the status, first rule that holds */
    var c = x.confidence || {};
    if (c.score == null || c.score < cfg.min_confidence) {
      out.status = status('LIMITED_DATA', 'EdgeDesk’s information on this game is below the floor it needs, so movement in the number is not read as news.');
    } else if (out.injury.flagged) {
      out.status = status('INJURY_UNCERTAINTY', 'A supplied availability report lists ' + out.injury.players.length
        + ' player' + (out.injury.players.length === 1 ? '' : 's') + ' with an unresolved status; the engine widens this game’s range for it.');
    } else if (out.change && out.change.points > cfg.move_significant) {
      out.status = status('SIGNIFICANT_CHANGE', 'EdgeDesk has moved ' + out.change.text + '.');
    } else if (out.change && out.change.points >= cfg.move_stable) {
      out.status = status('MOVING', 'EdgeDesk has moved ' + out.change.text + '.');
    } else if ((out.market_move && out.market_move.points >= cfg.line_move_pts) || (h2h != null && Math.abs(h2h) >= cfg.line_move_pp)) {
      out.status = status('LINE_MOVING', out.market_move && out.market_move.points >= cfg.line_move_pts
        ? 'EdgeDesk’s number is steady, but the market has moved ' + out.market_move.text + '.'
        : 'EdgeDesk’s number is steady, but the home moneyline has moved ' + Math.abs(h2h).toFixed(1) + ' pp since first capture.');
    } else if (out.change) {
      out.status = status('STABLE', 'EdgeDesk’s number is ' + out.change.text + '.');
    } else {
      out.status = status('NO_HISTORY', 'No earlier EdgeDesk number is stored for this game, so movement cannot be measured yet.');
    }
    return out;
  };

  /* ============================================================ THE BUILD
     input = {
       game:        {game_id, home, away, kickoff}
       projection:  the engine's projectGame output, unmodified
       market:      the board's market join (app.html fbP4Market):
                    {spread_line, book, as_of, stale, status, spread_fault}
       coverage:    the input contract's summary (fbP4ContractFor(u).summary):
                    {input_coverage, known, applicable}
       quotes:      captured per-book spread quotes with their freshness state
                    (see STEP 6), or absent
       record:      this game's entry in the committed model record, in margin
                    convention: {first:{at, margin}, latest:{at, margin},
                    revisions, market_entry, market_latest} (see STEP 7)
       h2h_pp:      home moneyline implied-probability move since first
                    capture, in points, or absent
       now:         the moment movement and freshness are judged against
     }
     over: CONFIG overrides — the page passes the engine's own thresholds */
  V.build = function (input, over) {
    input = input || {};
    var cfg = V.config(over);
    var game = input.game || {}, p = input.projection || null;
    var fl = V.fairLine(p, game);
    var gap = V.marketGap(fl, input.market || (p && p.market) || null, game);
    var conf = fl ? V.confidence(p, cfg) : V.confidence(null, cfg);
    var rel = V.reliability(input.coverage || null, cfg);
    var label = V.researchLabel({ fair: fl, market_gap: gap, confidence: conf, reliability: rel,
      projection_status: p ? p.status : null }, cfg);
    var out = {
      contract: V.version,
      game_id: game.game_id == null ? null : String(game.game_id),
      home: game.home || null, away: game.away || null,
      projected: !!fl,
      /* the engine's own status (PREDICTED, INSUFFICIENT_DATA, ...) */
      engine_status: p ? (p.status || null) : null,
      fair: fl,
      raw_projected_margin: fl ? fl.raw_projected_margin : null,
      display_fair_spread: fl ? fl.display_fair_spread : null,
      favorite_team: fl ? fl.favorite_team : null,
      underdog_team: fl ? fl.underdog_team : null,
      is_near_pickem: fl ? fl.is_near_pickem : false,
      market_gap: gap,
      market_spread: gap.market_spread,
      confidence: conf,
      reliability: rel,
      research_label: label,
      strongest_drivers: V.leanReasons(p, fl, gap, game, cfg),
      best_available_line: V.bestAvailable(input.quotes || null, fl, gap, game, cfg)
    };
    var h = V.projectionHistory({ fair: fl, record: input.record || null, now: input.now, home: game.home, away: game.away,
      projection: p, confidence: conf, h2h_pp: input.h2h_pp }, cfg);
    out.history = h;
    out.projection_status = h.status;
    out.projection_stability = h.stability;
    out.previous_projection = h.previous;
    out.projection_change = h.change;
    return out;
  };

  return V;
});

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
    drivers_max: 3
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

  /* ============================================================ THE BUILD
     input = {
       game:        {game_id, home, away, kickoff}
       projection:  the engine's projectGame output, unmodified
       market:      the board's market join (app.html fbP4Market):
                    {spread_line, book, as_of, stale, status, spread_fault}
       coverage:    the input contract's summary (fbP4ContractFor(u).summary):
                    {input_coverage, known, applicable}
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
    return {
      contract: V.version,
      game_id: game.game_id == null ? null : String(game.game_id),
      home: game.home || null, away: game.away || null,
      projected: !!fl,
      projection_status: p ? (p.status || null) : null,
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
      strongest_drivers: V.leanReasons(p, fl, gap, game, cfg)
    };
  };

  return V;
});

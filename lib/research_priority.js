/* ===========================================================================
   EdgeDesk research priority — the "5 Games Worth Researching" reading order.

   ONE question: where should a reader start researching this football board?
   It is answered from numbers the board has ALREADY produced. This file is a
   presentation layer over existing outputs, nothing more:

     - it computes no projection, no fair line, no win probability, no total,
       no power rating and no status — every one of those arrives on the
       candidate, and none of them is changed here;
     - it fills nothing in: a value a game does not carry stays null, and a
       game missing something the order needs is left out, never estimated;
     - the order is a READING order, not a ranking of bets. The score is not a
       probability, an edge or a confidence, and it is never shown as one.

   Browser: window.EDResearchPriority. Node: require('./research_priority.js').
   The adapter that turns the board's rows into candidates lives in app.html,
   next to fbGameRows(), so this file never reads page state. rank() returns
   each game with its score, the parts behind it and one deterministic
   "why research it" sentence (P.why).

   CANDIDATE (built by the adapter; anything missing stays null)
     key             stable id, e.g. 'nfl|2026_04_NYJ_CHI' — the last tie-break
     sport           'nfl' | 'cfb'
     home, away     display names
     kickoff         ms since epoch
     status          the board's OWN status label for the game (fbP4StatusFor
                     for CFB, fbNflResearchState for NFL) — read, never derived
     projected       the engine returned PREDICTED
     model_margin    EdgeDesk projected home margin (+ = home favoured)
     market_margin   market home margin, same convention
     normalized_gap  |model - market| / the model's own expected error (σ), as
                     lib/game_research.js computes it (model_vs_market)
     market          {kind:'live'|'consensus', age_h, stale, source}
                       live      a captured sportsbook quote with a capture time
                       consensus an archive / reference consensus line with none
     fault, thin     the board's DATA FAULT / THIN DATA conditions
     completeness    the shared research layer's data completeness (0-1), or
                     null where a league publishes none (the NFL model does not)
     flags           research-flag keys already raised for this game: the shared
                     layer's researchFlags plus the engine's own RESEARCH_LEAN
                     classification, passed as SPREAD_LEAN / TOTAL_LEAN
     qualifiers      the shared layer's qualifier flags (NO_MARKET, STALE_MARKET,
                     HIGH_UNCERTAINTY) — they qualify a game, never select one
     model_total, market_total, total_gap (model - market)
     movement        {spread_moved, spread_toward_model, h2h_pp}
                       spread_moved         pts the consensus moved since open
                       spread_toward_model  the same, signed: + toward EdgeDesk
                       h2h_pp               home implied probability, first
                                            capture to now, in points
     qb_unknown      the engine's own "QB starter unknown" warning is open
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDResearchPriority = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var P = { version: 'research_priority/1' };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function round1(x) { return Math.round(x * 10) / 10; }
  function has(list, k) { return !!list && list.indexOf(k) >= 0; }

  /* ------------------------------------------------------------ the rules
     Every threshold below is either an existing EdgeDesk threshold (named) or
     a weight of this ordering, and only the weights are new. */
  P.N = 5;
  /* both engines' own research threshold: football/engine.js classifyEdge
     (RESEARCH_LEAN at 2+ pts) and EDCfbP4Params.market.min_research_gap */
  P.RESEARCH_GAP = 2;
  /* where the CFB board turns RESEARCH into INVESTIGATE (fbP4StatusFor), and
     the size at which the app's own NFL copy says missing information is the
     likelier explanation (fbTodayItems). The same bar in both leagues. */
  P.ELEVATED_GAP = 7;
  /* the smallest h2h move the Today section already reports (fbTodayItems) */
  P.PRICE_MOVE_PP = 1;
  /* the statuses a game may carry and still be ordered here. NFL has no
     RESEARCH label: its research band is INVESTIGATE (2-14 pts) and its
     inside-2-pts state is AGREEMENT (fbNflResearchState). */
  P.ELIGIBLE_STATUSES = ['RESEARCH', 'INVESTIGATE', 'AGREEMENT'];

  /* the ordering's own weights, on a 0-100 scale */
  P.WEIGHTS = { disagreement: 35, flags: 25, market: 15, data: 15, movement: 10 };
  /* the normalized gap at which the disagreement term stops growing: twice the
     shared layer's LARGE_DISAGREEMENT floor (0.25σ). Past it, a bigger gap
     earns nothing more — it is at least as likely to be missing information. */
  P.Z_FULL = 0.5;
  P.FLAG_CAP = 3;
  P.MOVE_FULL = { spread_pts: 3, h2h_pp: 5 };
  P.MARKET_QUALITY = { live: 1, consensus: 0.5 };
  P.PENALTY = { elevated_gap: 20, high_uncertainty: 10, qb_unknown: 10, missing_input: 5 };

  /* INDEPENDENT means a different piece of evidence, not a different name for
     the same one: LARGE_DISAGREEMENT, the engine's spread lean and a favourite
     flip all say "the spread disagrees", so together they count once. */
  P.FLAG_FAMILY = {
    LARGE_DISAGREEMENT: 'spread', SPREAD_LEAN: 'spread', FAVORITE_FLIP: 'spread',
    TOTAL_LEAN: 'total',
    MARKET_TOWARD_MODEL: 'movement', MARKET_AWAY_FROM_MODEL: 'movement', KEY_NUMBER: 'movement',
    PRICE_MOVEMENT: 'movement',
    MODEL_CONSENSUS: 'models', LONE_OUTLIER: 'models',
    PRICE_DISPERSION: 'books'
  };
  P.QUALIFIERS = ['NO_MARKET', 'STALE_MARKET', 'HIGH_UNCERTAINTY'];

  P.REASONS = {
    NOT_PROJECTED: 'no valid EdgeDesk projection',
    NO_MARKET: 'no current market quote',
    DATA_FAULT: 'marked DATA FAULT',
    THIN_DATA: 'marked THIN DATA',
    STALE_MARKET: 'the market quote is stale',
    STATUS: 'status is not one this order reads',
    NO_NORMALIZED_GAP: 'no normalized gap (the model published no expected error)',
    NOTHING_TO_EXPLAIN: 'no research reason to explain selecting it'
  };

  P.RULE = 'Reading order, not a ranking of bets. Score (0-100, not a probability): '
    + 'normalized model-market gap 35 (full at ' + P.Z_FULL + 'σ), independent research flags 25 (full at '
    + P.FLAG_CAP + '), market quality 15 (captured quote 1, consensus line 0.5), data completeness 15 '
    + '(left out where a league publishes none), market movement 10; minus ' + P.PENALTY.elevated_gap
    + ' for an INVESTIGATE gap of ' + P.ELEVATED_GAP + '+ pts, ' + P.PENALTY.high_uncertainty
    + ' for high uncertainty, ' + P.PENALTY.qb_unknown + ' for an unknown QB starter and '
    + P.PENALTY.missing_input + ' per missing total. Ties: more independent flags, larger normalized gap, '
    + 'better completeness, fresher quote, earlier kickoff.';

  /* --------------------------------------------------------- derived facts */
  P.gap = function (c) {
    var m = c ? num(c.model_margin) : null, k = c ? num(c.market_margin) : null;
    return (m == null || k == null) ? null : Math.abs(m - k);
  };
  /* model and market name different favourites, by at least the research
     threshold — a half-point either side of pick'em is not a flip */
  P.favoriteFlip = function (c) {
    var m = c ? num(c.model_margin) : null, k = c ? num(c.market_margin) : null;
    if (m == null || k == null || m === 0 || k === 0) return false;
    if ((m > 0) === (k > 0)) return false;
    return Math.abs(m - k) >= P.RESEARCH_GAP;
  };
  P.flagsFor = function (c) {
    var keys = [];
    function add(k) { if (P.FLAG_FAMILY[k] && keys.indexOf(k) < 0) keys.push(k); }
    ((c && c.flags) || []).forEach(function (k) { if (!has(P.QUALIFIERS, k)) add(k); });
    if (P.favoriteFlip(c)) add('FAVORITE_FLIP');
    var h = c && c.movement ? num(c.movement.h2h_pp) : null;
    if (h != null && Math.abs(h) >= P.PRICE_MOVE_PP) add('PRICE_MOVEMENT');
    var fam = [];
    keys.forEach(function (k) { var f = P.FLAG_FAMILY[k]; if (fam.indexOf(f) < 0) fam.push(f); });
    fam.sort();
    return { keys: keys, families: fam, independent: fam.length };
  };
  P.uncertainty = function (c) {
    var r = [], g = P.gap(c);
    if (c && c.status === 'INVESTIGATE' && g != null && g >= P.ELEVATED_GAP) r.push('large_gap');
    if (c && has(c.qualifiers, 'HIGH_UNCERTAINTY')) r.push('high_uncertainty');
    if (c && c.qb_unknown) r.push('qb_unknown');
    return { elevated: r.length > 0, reasons: r };
  };
  P.hasReason = function (c) {
    var g = P.gap(c);
    return (g != null && g >= P.RESEARCH_GAP) || P.flagsFor(c).independent > 0;
  };

  /* ------------------------------------------------------------ the gates */
  P.eligibility = function (c) {
    var out = [];
    if (!c) return { eligible: false, reasons: ['NOT_PROJECTED'] };
    if (!c.projected || num(c.model_margin) == null || c.status === 'AWAITING DATA' || c.status === 'NOT PRICED')
      out.push('NOT_PROJECTED');
    if (num(c.market_margin) == null || !c.market || !P.MARKET_QUALITY[c.market.kind]
      || c.status === 'NO MARKET' || has(c.qualifiers, 'NO_MARKET'))
      out.push('NO_MARKET');
    if (c.fault || c.status === 'DATA FAULT') out.push('DATA_FAULT');
    if (c.thin || c.status === 'THIN DATA') out.push('THIN_DATA');
    if (c.status === 'STALE QUOTE' || (c.market && c.market.stale) || has(c.qualifiers, 'STALE_MARKET'))
      out.push('STALE_MARKET');
    if (!out.length && P.ELIGIBLE_STATUSES.indexOf(c.status) < 0) out.push('STATUS');
    if (!out.length && num(c.normalized_gap) == null) out.push('NO_NORMALIZED_GAP');
    if (!out.length && !P.hasReason(c)) out.push('NOTHING_TO_EXPLAIN');
    return { eligible: out.length === 0, reasons: out };
  };

  /* ------------------------------------------------------------ the score */
  P.marketQuality = function (m) {
    if (!m || !m.kind) return null;
    var q = P.MARKET_QUALITY[m.kind];
    return q == null ? null : q;
  };
  P.movementInterest = function (mv) {
    var s = mv ? num(mv.spread_moved) : null, h = mv ? num(mv.h2h_pp) : null, a = 0;
    if (s != null) a = Math.max(a, Math.min(Math.abs(s) / P.MOVE_FULL.spread_pts, 1));
    if (h != null) a = Math.max(a, Math.min(Math.abs(h) / P.MOVE_FULL.h2h_pp, 1));
    return a;
  };
  /* research_interest_score. A component a game cannot carry (the NFL model
     publishes no completeness) is left out of THAT game's weighted average —
     neither credited nor charged — rather than filled with a stand-in. */
  P.score = function (c) {
    var z = num(c.normalized_gap), fl = P.flagsFor(c), unc = P.uncertainty(c);
    var parts = {
      disagreement: z == null ? null : Math.min(Math.abs(z) / P.Z_FULL, 1),
      flags: Math.min(fl.independent, P.FLAG_CAP) / P.FLAG_CAP,
      market: P.marketQuality(c.market),
      data: num(c.completeness),
      movement: P.movementInterest(c.movement)
    };
    var sum = 0, den = 0, omitted = [];
    Object.keys(P.WEIGHTS).forEach(function (k) {
      if (parts[k] == null) { omitted.push(k); return; }
      sum += P.WEIGHTS[k] * parts[k]; den += P.WEIGHTS[k];
    });
    var base = den ? 100 * sum / den : 0;
    var pu = 0;
    unc.reasons.forEach(function (r) {
      pu += r === 'large_gap' ? P.PENALTY.elevated_gap : r === 'high_uncertainty' ? P.PENALTY.high_uncertainty : P.PENALTY.qb_unknown;
    });
    var missing = [];
    if (num(c.market_total) == null) missing.push('market_total');
    if (num(c.model_total) == null) missing.push('model_total');
    var pm = missing.length * P.PENALTY.missing_input;
    return {
      score: round1(base - pu - pm), base: round1(base), parts: parts, omitted: omitted,
      penalties: { uncertainty: pu, missing_data: pm }, missing: missing,
      uncertainty: unc, flags: fl
    };
  };

  /* ---------------------------------------------------- why research it
     One sentence per game, chosen by a fixed priority and filled ONLY from
     numbers already on the candidate. Nothing is generated, and a kind of
     evidence a game does not carry — movement with no opening line and no
     capture history — is never named.

       1  favourite flip        model and market name different favourites
       2  meaningful movement   the spread moved 1+ pt since the open (the
                                shared layer's MARKET_TOWARD/AWAY rule), crossed
                                a key number, or the home price moved 3+ pp
       3  multiple flags        2+ independent research-flag families
       4  large gap, good data  LARGE_DISAGREEMENT (0.25σ+), uncertainty normal
       5  large gap, uncertain  the same, with uncertainty elevated
       6  the flag it carries   the shape of the spread gap, a total lean,
                                smaller price movement, other models, books */
  P.LARGE_Z = 0.25;              /* lib/game_research.js LARGE_DISAGREEMENT */
  P.MEANINGFUL_MOVE = { spread_pts: 1, h2h_pp: 3 };
  P.STRONG_COVERAGE = 0.85;
  /* "one of the largest" is only said of a top-3 gap in a field of 5+ */
  P.LARGEST_TOP = 3;
  P.LARGEST_MIN_FIELD = 5;
  P.FAMILY_ORDER = ['spread', 'total', 'movement', 'models', 'books'];
  P.FAMILY_LABEL = { spread: 'spread disagreement', total: 'total disagreement', movement: 'market movement',
    models: 'other models', books: 'book dispersion' };

  function fmt(v) { return String(Math.round(Math.abs(v) * 10) / 10); }
  function pts1(v) { return Math.abs(v).toFixed(1); }
  function andList(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function favName(c, margin) { return margin > 0 ? c.home : c.away; }
  function keyCmp(a, b) { return String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0; }

  P.isLarge = function (c) {
    var z = num(c.normalized_gap);
    return has(c.flags, 'LARGE_DISAGREEMENT') || (z != null && Math.abs(z) >= P.LARGE_Z);
  };
  /* a top-3 raw gap among the research-grade (not elevated) games in ctx */
  P.amongLargest = function (c, ctx) {
    var field = (ctx || []).filter(function (x) { return P.gap(x) != null && !P.uncertainty(x).elevated; });
    if (field.length < P.LARGEST_MIN_FIELD) return false;
    field.sort(function (a, b) { return (P.gap(b) - P.gap(a)) || keyCmp(a, b); });
    for (var i = 0; i < P.LARGEST_TOP && i < field.length; i++) if (field[i].key === c.key) return true;
    return false;
  };
  function toward(c, h2h) { return h2h > 0 ? c.home : c.away; }
  P.movementRead = function (c, minPp) {
    var mv = c.movement || {}, s = num(mv.spread_toward_model), h = num(mv.h2h_pp);
    if (s != null && Math.abs(s) >= P.MEANINGFUL_MOVE.spread_pts)
      return 'The market has moved ' + fmt(s) + ' pt' + (fmt(s) === '1' ? '' : 's')
        + (s > 0 ? ' toward' : ' away from') + ' EdgeDesk’s number since the open.';
    if (s == null && has(c.flags, 'MARKET_TOWARD_MODEL')) return 'The market has moved toward EdgeDesk’s number since the open.';
    if (s == null && has(c.flags, 'MARKET_AWAY_FROM_MODEL')) return 'The market has moved away from EdgeDesk’s number since the open.';
    if (has(c.flags, 'KEY_NUMBER')) return 'The market line has moved across a key number since the open.';
    if (h != null && Math.abs(h) >= (minPp == null ? P.MEANINGFUL_MOVE.h2h_pp : minPp))
      return 'The market has moved ' + fmt(h) + ' pp toward ' + toward(c, h)
        + ' on the moneyline since first capture; the model does not see news.';
    return null;
  };
  function coverage(c) {
    var q = num(c.completeness);
    if (q == null) return 'no data warnings open';
    var pct = Math.round(q * 100) + '%';
    return q >= P.STRONG_COVERAGE ? 'strong data coverage (' + pct + ')' : pct + ' data coverage';
  }
  function uncertainPhrase(unc) {
    if (has(unc.reasons, 'qb_unknown')) return 'a starting quarterback is unknown';
    if (has(unc.reasons, 'high_uncertainty')) return 'its input data is incomplete or out of date';
    return 'uncertainty is elevated';
  }
  function spreadShape(c, g, m, k) {
    if (m != null && k != null && g != null && g >= P.RESEARCH_GAP && k !== 0 && (m === 0 || (m > 0) === (k > 0))) {
      if (Math.abs(m) < Math.abs(k))
        return 'Model sees this matchup much closer than the market does: '
          + (m === 0 ? 'EdgeDesk has it even, the market has ' + favName(c, k) + ' by ' + fmt(k)
            : 'EdgeDesk has ' + favName(c, m) + ' by ' + fmt(m) + ', the market by ' + fmt(k)) + '.';
      return 'Model sees ' + favName(c, m) + ' winning by more than the market does: '
        + fmt(m) + ' points, not ' + fmt(k) + '.';
    }
    return g != null && g >= P.RESEARCH_GAP ? 'Model and market disagree by ' + pts1(g) + ' points.' : null;
  }
  function otherFlag(c, fl, g, m, k) {
    var t;
    if (has(fl.families, 'spread') && (t = spreadShape(c, g, m, k))) return t;
    if (has(fl.families, 'total')) {
      var tg = num(c.total_gap);
      return tg == null || tg === 0 ? 'Model and market disagree on the total.'
        : 'Model sees the total ' + pts1(tg) + ' points ' + (tg > 0 ? 'higher' : 'lower') + ' than the market.';
    }
    if (has(fl.families, 'movement') && (t = P.movementRead(c, P.PRICE_MOVE_PP))) return t;
    if (has(fl.keys, 'MODEL_CONSENSUS')) return 'Most Collective models lean the same way as EdgeDesk here.';
    if (has(fl.keys, 'LONE_OUTLIER')) return 'EdgeDesk is the only model on its side of this market.';
    if (has(fl.families, 'books')) return 'Books disagree with each other by a point or more on this spread.';
    return (t = spreadShape(c, g, m, k)) ? t
      : (g != null ? 'Model and market are ' + pts1(g) + ' points apart.' : 'An existing research flag is active.');
  }
  P.why = function (c, ctx) {
    var g = P.gap(c), m = num(c.model_margin), k = num(c.market_margin);
    var fl = P.flagsFor(c), unc = P.uncertainty(c), t;
    if (P.favoriteFlip(c))
      return { code: 'favorite_flip', text: 'Model flips the market favorite: EdgeDesk has ' + favName(c, m) + ' by '
        + fmt(m) + ', the market has ' + favName(c, k) + ' by ' + fmt(k) + '.' };
    if ((t = P.movementRead(c))) return { code: 'market_movement', text: t };
    if (fl.independent >= 2)
      return { code: 'multiple_flags', text: 'Multiple independent research flags are active: '
        + andList(P.FAMILY_ORDER.filter(function (f) { return has(fl.families, f); })
          .map(function (f) { return P.FAMILY_LABEL[f]; })) + '.' };
    if (g != null && P.isLarge(c)) {
      if (unc.elevated)
        return { code: 'large_uncertain', text: 'Large disagreement, but ' + uncertainPhrase(unc) + ' — inspect the inputs.' };
      if (P.amongLargest(c, ctx))
        return { code: 'largest_disagreement', text: 'One of the largest research-grade spread disagreements on the board: '
          + pts1(g) + ' points.' };
      return { code: 'large_disagreement', text: 'Model and market disagree by ' + pts1(g) + ' points with ' + coverage(c) + '.' };
    }
    return { code: 'other_flag', text: otherFlag(c, fl, g, m, k) };
  };

  /* ---------------------------------------------------------- the order
     Total and deterministic: the key is unique, so no two games ever compare
     equal and the input order can never change the output. */
  function nullLast(a, b, dir) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return dir * (a - b);
  }
  P.compare = function (a, b) {
    var ca = a.candidate, cb = b.candidate;
    return (b.score - a.score)
      || (b.detail.flags.independent - a.detail.flags.independent)
      || nullLast(num(ca.normalized_gap) == null ? null : Math.abs(ca.normalized_gap),
                  num(cb.normalized_gap) == null ? null : Math.abs(cb.normalized_gap), -1)
      || nullLast(num(ca.completeness), num(cb.completeness), -1)
      || nullLast(ca.market ? num(ca.market.age_h) : null, cb.market ? num(cb.market.age_h) : null, 1)
      || nullLast(num(ca.kickoff), num(cb.kickoff), 1)
      || (String(ca.key) < String(cb.key) ? -1 : String(ca.key) > String(cb.key) ? 1 : 0);
  };
  P.rank = function (cands, n) {
    n = n == null ? P.N : n;
    var seen = {}, ordered = [], excluded = [];
    (cands || []).forEach(function (c) {
      if (!c || c.key == null || seen[c.key]) return;
      seen[c.key] = 1;
      var e = P.eligibility(c);
      if (!e.eligible) { excluded.push({ key: c.key, candidate: c, reasons: e.reasons }); return; }
      var s = P.score(c);
      ordered.push({ key: c.key, candidate: c, score: s.score, detail: s });
    });
    ordered.sort(P.compare);
    var field = ordered.map(function (x) { return x.candidate; });
    var items = ordered.slice(0, n).map(function (x, i) { x.rank = i + 1; x.why = P.why(x.candidate, field); return x; });
    excluded.sort(keyCmp);
    return { items: items, eligible: ordered.length, excluded: excluded, rule: P.RULE };
  };

  return P;
});

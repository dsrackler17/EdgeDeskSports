/* ===========================================================================
   EdgeDesk CFB RESEARCH TERMINAL — one canonical research object per game.

   A normal +EV tool answers "which sportsbook price looks favourable against
   another price?". This layer answers the questions a bettor has to answer
   BEFORE a line deserves action, from EdgeDesk's own production outputs only:

     A  EDGEDESK VIEW      what the champion model makes the game, and how sure
     B  MARKET             what the books make it, how fresh, how many
     C  DISAGREEMENT       the gap, verified or not, and where the market went
     D  WHY THIS NUMBER    the champion's own additive terms, summed exactly
     E  WHAT COULD BE WRONG uncertainty, QB, roster, cross-model, thin data
     F  PRICE DECISION     cover probability, break-even, EV, bettable-to,
                           the price curve and the status
     G  MARKET TIMING      bet now vs wait, only with validated evidence
     H  HISTORY            comparable situations, only with a real sample

   plus what would have to be wrong for the market to be right, the fair-line
   sensitivity, what changed, the projection and market timelines, edge
   decay, line shopping, the model consensus, matchup cards, paths to cover
   and to failure, data quality, the trust panel, "is the market telling us
   something?", a research-queue score, the weekly brief, the record views
   and a research assistant that answers only from these objects.

   WHAT THIS FILE NEVER DOES
     - it never computes a projection. The fair line, the win probability, the
       sigma and the margin distribution are the champion engine's; the
       caller (football/cfb_terminal/build.js) hands them in, and the cover
       probability at any line comes from the engine's own calibrated margin
       PMF through b.dist.cover(). Nothing is re-derived here;
     - it never lets the market into the pure projection. Market movement is
       reported beside the model and is never an input to it (tests pin it);
     - it never invents a value. A missing input stays null and the object
       says UNKNOWN / unavailable, with the reason;
     - it never makes a bet. BET is only ever the decision engine's verdict
       (football/cfb_decision/decision.js, fail closed), passed in as
       b.decision. Explanations, the assistant and the UI read the status;
       none of them can write it (T.freeze + tests).

   Browser: window.EDCfbTerminal. Node: require('./cfb_terminal.js'). ES5, no
   dependencies, same code in both.

   CONVENTIONS
     margin      home perspective, + = home favoured by (engine fair_spread,
                 the Lab's pure_home_margin)
     book line   what a book prints: home line -7 = home laying 7 (margin 7)
     gap         EdgeDesk margin - market margin (+ = EdgeDesk likes HOME more)
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCfbTerminal = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var T = { version: 'cfb_terminal/1', schema: 'edgedesk_cfb_research_v1' };

  /* ------------------------------------------------------------- helpers */
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function r1(x) { return num(x) == null ? null : Math.round(x * 10) / 10; }
  function r2(x) { return num(x) == null ? null : Math.round(x * 100) / 100; }
  function r3(x) { return num(x) == null ? null : Math.round(x * 1000) / 1000; }
  function r4(x) { return num(x) == null ? null : Math.round(x * 10000) / 10000; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function ms(t) { if (t == null) return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  function iso(t) { var x = ms(t); return x == null ? null : new Date(x).toISOString(); }
  function pct(p, dp) { return num(p) == null ? null : (100 * p).toFixed(dp == null ? 1 : dp) + '%'; }
  function pp(x, dp) { return num(x) == null ? null : (x >= 0 ? '+' : '') + (100 * x).toFixed(dp == null ? 1 : dp) + ' pp'; }
  function signed(x, dp) { return num(x) == null ? null : (x > 0 ? '+' : (x < 0 ? '−' : '')) + Math.abs(x).toFixed(dp == null ? 1 : dp); }
  function median(xs) {
    var a = xs.filter(function (x) { return num(x) != null; }).slice().sort(function (p, q) { return p - q; });
    if (!a.length) return null;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function sd(xs) {
    var a = xs.filter(function (x) { return num(x) != null; });
    if (a.length < 2) return null;
    var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  /* Wilson 95% interval for k successes in n */
  function wilson(k, n) {
    if (!n) return [null, null];
    var z = 1.96, p = k / n, d = 1 + z * z / n;
    var c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [r4(Math.max(0, c - h)), r4(Math.min(1, c + h))];
  }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }
  T.freeze = deepFreeze;
  T.util = { num: num, r1: r1, r2: r2, pct: pct, pp: pp, signed: signed, median: median, sd: sd, wilson: wilson, ms: ms, iso: iso };

  /* a book line for a side, as printed: -3.5, +7, PK */
  function bookText(v) { if (num(v) == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '') + (Math.round(v * 2) / 2).toFixed(1).replace(/\.0$/, ''); }
  function bookTextExact(v) { if (num(v) == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '') + String(r1(v)).replace(/\.0$/, ''); }
  function priceText(a) { return num(a) == null ? '' : (a > 0 ? '+' + a : String(a)); }
  /* "Texas Tech -12.3" from a home margin */
  function marginLine(m, home, away, dp) {
    if (num(m) == null) return null;
    if (Math.abs(m) < 0.05) return 'Pick’em';
    var d = dp == null ? 1 : dp;
    return (m > 0 ? home : away) + ' -' + Math.abs(m).toFixed(d);
  }
  T.format = { bookText: bookText, priceText: priceText, marginLine: marginLine };

  /* ------------------------------------------------------------- odds */
  function payout(a) { if (num(a) == null || a === 0 || (a > -100 && a < 100)) return null; return a > 0 ? a / 100 : 100 / (-a); }
  function breakEven(a) { var b = payout(a); return b == null ? null : 1 / (1 + b); }
  /* EV per unit risked: a push returns the stake */
  function ev(pWin, pPush, a) {
    var b = payout(a);
    if (b == null || num(pWin) == null) return null;
    var pu = num(pPush) || 0, pl = 1 - pWin - pu;
    return pWin * b - pl;
  }
  T.odds = { payout: payout, breakEven: breakEven, ev: ev };

  /* =================================================================
     THE RULES. Every threshold is an existing EdgeDesk threshold, named
     where it comes from, or a presentation threshold of this layer, said
     so. A caller may override from the live policy (build.js passes the
     frozen decision policy's own numbers).
     ================================================================= */
  T.CONFIG = {
    /* EDCfbP4Params.market.min_research_gap / lib/cfb_research_view.js */
    research_gap: 2,
    /* the integrity gate's first tier (lib/cfb_disagreement.js MAJOR_7) */
    major_gap: 7,
    /* FB_GUARD.p4.game: past it an unverified gap reads as a data fault */
    guard_gap: 21,
    /* the engine's own confidence floor and the card's high band */
    min_confidence: 35, high_confidence: 60,
    /* lib/cfb_reliability.js grades: under 60 LOW, 80+ STRONG */
    low_reliability: 60, strong_reliability: 80,
    /* cfb_decision_policy_v1: the probability edge over break-even a BET
       needs (min) and the "ideal" edge the price targets use */
    min_probability_edge: 0.01, ideal_probability_edge: 0.02,
    /* cfb_decision_policy_v1.stale_minutes: an older quote is not a price */
    stale_minutes: 180,
    /* cfb_decision_policy_v1.min_books / max_dispersion_iqr */
    min_books: 3, max_dispersion_iqr: 1.5,
    /* cfb_decision_policy_v1.max_ensemble_sd — past it the models disagree
       too much for a wager */
    max_model_sd: 6,
    /* PRESENTATION: model agreement tiers on the dispersion (SD, points) of
       the independent model numbers. A tight cluster under 1.5 pts is HIGH,
       under 3 MODERATE, otherwise LOW */
    agree_high_sd: 1.5, agree_moderate_sd: 3,
    /* football/validation/movement_cfb.json: the held-out mean absolute
       open-to-close move of a college line (mae_no_move, 2013-2025) — a
       target price inside it is within ordinary movement. build.js reads
       the file; this is its value at the time of writing */
    typical_move_pts: 1.9,
    /* PRESENTATION: the price-curve grades on the model's probability edge.
       marginal = policy min, acceptable = policy ideal, strong = twice ideal */
    grade_strong_edge: 0.04,
    /* PRESENTATION: a market move this size is "moving" (research_priority.js
       MEANINGFUL_MOVE is 1 pt; half a point is the smallest printed move) */
    move_pts: 0.5,
    /* PRESENTATION: never print a historical rate under this many games */
    history_min_n: 30,
    /* the edge-decay verdict bands, on current gap / initial gap (same side) */
    decay_most_gone: 0.4, decay_partial: 0.75, decay_grew: 1.1,
    /* the price curve: half points either side of the best current line */
    curve_half_points: 6
  };
  T.config = function (over) {
    var o = {}, k;
    for (k in T.CONFIG) if (has(T.CONFIG, k)) o[k] = T.CONFIG[k];
    if (over) for (k in over) if (has(over, k) && over[k] != null) o[k] = over[k];
    return o;
  };

  /* =================================================================
     CANONICAL TERMINOLOGY — one definition, every surface.
     ================================================================= */
  T.TERMS = {
    EDGEDESK_FAIR: 'The spread EdgeDesk’s governance champion model makes the game from football information alone. The market never enters it.',
    MARKET_CONSENSUS: 'The median current spread across the sportsbooks EdgeDesk captured for this game, from quotes inside the freshness window.',
    MODEL_GAP: 'EdgeDesk fair minus market consensus, in points, stated toward the team EdgeDesk likes more than the market does.',
    COVER_PROBABILITY: 'The chance a side covers a specific line, from the champion model’s own calibrated margin distribution (pushes excluded; the push chance is shown beside it). It is about the spread, not about who wins.',
    WIN_PROBABILITY: 'The chance a team wins the game outright. It is not the chance a bet on the spread wins.',
    BREAK_EVEN: 'The cover probability a price needs just to break even: 52.4% at -110.',
    EV: 'Expected value per unit risked at a specific price, from the cover and push probabilities. EdgeDesk’s model EV is research until the decision engine validates it for the model that produced it.',
    RELIABILITY: 'How much EdgeDesk trusts the completeness, freshness and consistency of the inputs under the projection (0-100). It is NOT a probability and NOT a chance of winning.',
    FOOTBALL_CONFIDENCE: 'How good EdgeDesk’s football information is for this game, weighted by how much each input matters (0-100). It is not a probability either.',
    BET_QUALITY: 'Whether the decision engine certifies a wager at a named price. Only the engine sets it; it fails closed.',
    CLV: 'Closing-line value, in points: how far the market moved toward the side EdgeDesk took, from the number EdgeDesk recorded to the close. Positive means the recorded number beat the close. It is not the same as winning.',
    VERIFIED_DISAGREEMENT: 'A model gap of 7+ points that passed every integrity check (right game and orientation, fresh multi-book market, current-season ratings, resolved QB, no abnormal availability, adjustments inside their validated range, independent submodel support). It is still not a bet.',
    RESEARCH_INTEREST: 'How worth opening a game is: verified disagreement, price, confidence, model agreement, movement and unresolved information together. It is never a bet ranking.',
    DATA_QUALITY: 'How complete and fresh the inputs are. Kept separate from any probability: good data does not make a side more likely to cover.'
  };

  /* =================================================================
     THE STATUS LANGUAGE — seven words, one meaning each.
     ================================================================= */
  T.STATUS = {
    BET: { label: 'BET', tone: 'bet', rank: 7,
      means: 'The decision engine certified a wager at a named price: every validated threshold cleared, betting is enabled, the market is fresh. Always shown with the price and the number it is bettable to.' },
    WAIT: { label: 'WAIT', tone: 'wait', rank: 5,
      means: 'A real disagreement exists, but not at this state: a named piece of information resolves before kickoff, or the price has to reach a named number first. Never a forecast that the line will move.' },
    RESEARCH: { label: 'RESEARCH', tone: 'research', rank: 6,
      means: 'EdgeDesk and the market disagree by a research-sized amount at a live price, with usable confidence and reliability. Worth opening — not a certified bet.' },
    INVESTIGATE: { label: 'INVESTIGATE', tone: 'investigate', rank: 4,
      means: 'A 7+ point gap that has not passed the integrity checks. At that size missing information is more often the cause than an edge.' },
    PASS: { label: 'PASS', tone: 'pass', rank: 3,
      means: 'EdgeDesk sees no disagreement worth acting on at this price, or it cannot trust its own number enough. The reason is always printed.' },
    DATA_FAULT: { label: 'DATA FAULT', tone: 'fault', rank: 2,
      means: 'An integrity check found a data problem (a mis-joined line, an inverted spread, a gap past the guard bound). EdgeDesk’s number is unsafe until it is explained.' },
    NO_MARKET: { label: 'NO MARKET', tone: 'nomarket', rank: 1,
      means: 'No usable current quote: none captured, or only a stale one. Nothing is actionable without a live price.' }
  };
  T.STATUS_KEYS = ['BET', 'RESEARCH', 'WAIT', 'INVESTIGATE', 'PASS', 'DATA_FAULT', 'NO_MARKET'];
  /* how the older vocabularies map onto the seven words (docs/cfb-terminal/TERMINOLOGY.md) */
  T.LEGACY_MAP = {
    'WORTH RESEARCHING': 'RESEARCH', 'MARKET ALIGNED': 'PASS', 'NEAR PICK’EM': 'PASS', 'LIMITED DATA': 'PASS or NO_MARKET',
    'LOW RELIABILITY': 'PASS', 'MARKET FAULT': 'INVESTIGATE (a 7+ gap the market is too thin to verify)', 'VERIFIED MAJOR DISAGREEMENT': 'RESEARCH + the verified badge',
    'LEAN': 'RESEARCH (the record’s gap rule)', 'NO_BET': 'PASS (fail-closed decision)', 'STALE QUOTE': 'NO_MARKET'
  };

  /* =================================================================
     A. EDGEDESK VIEW
     b.model = { model_version, label, role, home_margin, fair_total,
                 home_points, away_points, home_win_prob, sigma, sigma_basis,
                 football_confidence, prediction_ts, source }
     b.dist  = { quantiles:{p10,p25,p50,p75,p90}, basis, cover(marginLine) }
     ================================================================= */
  T.edgedeskView = function (b, cfg) {
    var g = b.game || {}, m = b.model || {};
    var home = g.home, away = g.away, mar = num(m.home_margin);
    if (mar == null) {
      return { available: false, reason: m.unavailable_reason || 'EdgeDesk has no valid projection for this game',
        model_version: m.model_version || null, label: m.label || null };
    }
    var q = (b.dist && b.dist.quantiles) || {};
    var conf = num(m.football_confidence);
    var tier = conf == null ? null : (conf < cfg.min_confidence ? 'LOW' : (conf < cfg.high_confidence ? 'MODERATE' : 'HIGH'));
    var fav = mar > 0 ? home : (mar < 0 ? away : null);
    return {
      available: true,
      model_version: m.model_version || null, label: m.label || null, role: m.role || null,
      home_margin: r2(mar),
      fair_home_line: r2(-mar),
      fair_text: marginLine(mar, home, away, 1),
      favorite: fav,
      projected_score: (num(m.home_points) != null && num(m.away_points) != null)
        ? { home: r1(m.home_points), away: r1(m.away_points), text: away + ' ' + r1(m.away_points) + ' — ' + home + ' ' + r1(m.home_points) } : null,
      home_win_prob: r4(m.home_win_prob), away_win_prob: num(m.home_win_prob) == null ? null : r4(1 - m.home_win_prob),
      fair_total: r1(m.fair_total),
      sigma: r2(m.sigma), sigma_basis: m.sigma_basis || null,
      interval_80: (num(q.p10) != null && num(q.p90) != null) ? { lo: q.p10, hi: q.p90,
        text: marginLine(q.p10, home, away, 0) + ' to ' + marginLine(q.p90, home, away, 0) } : null,
      quantiles: { p10: num(q.p10), p25: num(q.p25), p50: num(q.p50), p75: num(q.p75), p90: num(q.p90) },
      distribution_basis: (b.dist && b.dist.basis) || null,
      football_confidence: { score: conf, tier: tier, label: tier ? tier.charAt(0) + tier.slice(1).toLowerCase() : 'Unavailable' },
      prediction_ts: m.prediction_ts || null,
      source: m.source || null
    };
  };

  /* =================================================================
     B. MARKET
     b.market = { quotes:[{book, source, home_line, price_home, price_away,
                  observed_at}], open_home_line, open_at, close_home_line,
                  as_of (build time) }
     Only pregame spread quotes observed at or before the build time reach
     here (build.js filters); this function still refuses a later one.
     ================================================================= */
  function latestPerBook(quotes, asOf) {
    var by = {};
    (quotes || []).forEach(function (q) {
      if (!q || num(q.home_line) == null || !q.book) return;
      var t = ms(q.observed_at);
      if (t == null || (asOf != null && t > asOf)) return;          /* point in time */
      var k = String(q.book).toLowerCase();
      if (!by[k] || t > ms(by[k].observed_at)) by[k] = q;
    });
    return Object.keys(by).sort().map(function (k) { return by[k]; });
  }
  T.latestPerBook = latestPerBook;
  T.marketView = function (b, cfg) {
    var g = b.game || {}, mk = b.market || {}, now = ms(b.now);
    var books = latestPerBook(mk.quotes, now);
    var fresh = books.filter(function (q) { return (now - ms(q.observed_at)) / 60000 <= cfg.stale_minutes; });
    var out = { available: false, books_total: books.length, books_fresh: fresh.length, quotes: [],
      open_home_line: num(mk.open_home_line), open_at: mk.open_at || null, stale: false, as_of: null, age_minutes: null,
      consensus_home_line: null, dispersion: null, move_since_open: null, sources: [] };
    if (!books.length) { out.reason = 'no spread quote captured for this game'; return out; }
    var use = fresh.length ? fresh : books;
    out.stale = !fresh.length;
    var newest = Math.max.apply(null, books.map(function (q) { return ms(q.observed_at); }));
    out.as_of = iso(newest);
    out.age_minutes = Math.round((now - newest) / 60000);
    out.consensus_home_line = r2(median(use.map(function (q) { return q.home_line; })));
    var lines = use.map(function (q) { return q.home_line; }).sort(function (p, q) { return p - q; });
    out.dispersion = lines.length > 1 ? r2(lines[lines.length - 1] - lines[0]) : 0;
    out.sources = Object.keys(books.reduce(function (s, q) { s[q.source || 'unknown'] = 1; return s; }, {}));
    out.quotes = books.map(function (q) {
      var age = Math.round((now - ms(q.observed_at)) / 60000);
      return { book: q.book, source: q.source || null, home_line: q.home_line, away_line: -q.home_line,
        price_home: num(q.price_home), price_away: num(q.price_away), observed_at: q.observed_at,
        age_minutes: age, fresh: age <= cfg.stale_minutes };
    });
    /* best current number on each side, from FRESH priced quotes only */
    function best(side) {
      var c = fresh.filter(function (q) { return num(side === 'home' ? q.price_home : q.price_away) != null; });
      if (!c.length) return null;
      c.sort(function (x, y) {
        var lx = side === 'home' ? x.home_line : -x.home_line, ly = side === 'home' ? y.home_line : -y.home_line;
        if (ly !== lx) return ly - lx;                                /* more points is better */
        var px = payout(side === 'home' ? x.price_home : x.price_away), py = payout(side === 'home' ? y.price_home : y.price_away);
        return (py || 0) - (px || 0);
      });
      var q = c[0], line = side === 'home' ? q.home_line : -q.home_line;
      return { book: q.book, line: line, price: side === 'home' ? q.price_home : q.price_away, observed_at: q.observed_at,
        text: (side === 'home' ? g.home : g.away) + ' ' + bookText(line) + ' ' + priceText(side === 'home' ? q.price_home : q.price_away) };
    }
    out.best = { home: best('home'), away: best('away') };
    if (out.open_home_line != null && out.consensus_home_line != null) {
      var mv = out.consensus_home_line - out.open_home_line;        /* + = moved toward AWAY (home line rose) */
      out.move_since_open = { points: r2(Math.abs(mv)), toward: mv > 0 ? 'away' : (mv < 0 ? 'home' : null),
        toward_team: mv > 0 ? g.away : (mv < 0 ? g.home : null),
        text: Math.abs(mv) < 0.05 ? 'unchanged since open' : Math.abs(mv).toFixed(1) + ' pts toward ' + (mv > 0 ? g.away : g.home) + ' since open' };
    }
    out.available = true;
    out.consensus_text = out.consensus_home_line == null ? null : marginLine(-out.consensus_home_line, g.home, g.away, 1);
    out.freshness_rule = 'a quote older than ' + cfg.stale_minutes + ' minutes is not a price (cfb_decision_policy_v1.stale_minutes)';
    return out;
  };

  /* =================================================================
     C. DISAGREEMENT
     b.integrity = lib/cfb_disagreement.js evaluate() result for a 7+ gap
                   (build.js runs it exactly as the Model Lab does), or null
     ================================================================= */
  T.disagreementView = function (b, A, B, cfg) {
    var g = b.game || {};
    var out = { available: false, points: null, signed: null, toward: null, toward_team: null,
      class: null, class_label: null, verification: 'NOT_REQUIRED', verified: false, integrity: null,
      market_direction: 'UNKNOWN', market_direction_text: null, favorite_flip: false };
    if (!A.available || !B.available || B.consensus_home_line == null) {
      out.reason = !A.available ? 'no EdgeDesk projection' : 'no market consensus to compare with';
      return out;
    }
    var mkt = -B.consensus_home_line, gap = A.home_margin - mkt, abs = Math.abs(gap);
    out.available = true;
    out.signed = r2(gap); out.points = r2(abs);
    out.toward = gap > 0 ? 'home' : (gap < 0 ? 'away' : null);
    out.toward_team = out.toward === 'home' ? g.home : (out.toward === 'away' ? g.away : null);
    out.market_margin = r2(mkt);
    out.favorite_flip = (A.home_margin > 0) !== (mkt > 0) && Math.abs(A.home_margin) >= 0.5 && Math.abs(mkt) >= 0.5;
    out.text = abs < 0.05 ? 'EdgeDesk matches the market' : abs.toFixed(1) + ' pts toward ' + out.toward_team;
    out.class = abs >= cfg.major_gap ? 'MAJOR' : (abs >= cfg.research_gap ? 'MODERATE' : 'ALIGNED');
    out.class_label = { MAJOR: 'Major disagreement', MODERATE: 'Moderate disagreement', ALIGNED: 'Market aligned' }[out.class];
    /* the integrity gate decides a 7+ gap: never verified by default */
    if (out.class === 'MAJOR') {
      var d = b.integrity || null;
      out.integrity = d ? { status: d.status || null, status_label: d.status_label || null, verification: d.verification || null,
        failed: (d.checks || []).filter(function (c) { return c.status === 'FAIL'; }).map(function (c) { return c.detail; }).slice(0, 4),
        incomplete: (d.checks || []).filter(function (c) { return c.status === 'INCOMPLETE'; }).map(function (c) { return c.detail; }).slice(0, 4),
        root_cause: d.root_cause ? d.root_cause.primary : null, checks_n: (d.checks || []).length,
        failed_checks: (d.checks || []).filter(function (c) { return c.status === 'FAIL'; }).map(function (c) { return { group: c.group, id: c.id, cause: c.cause || null, detail: c.detail }; }) } : null;
      if (d && d.status === 'VERIFIED_MAJOR_DISAGREEMENT') { out.verification = 'VERIFIED'; out.verified = true; }
      else if (d && d.status === 'DATA_FAULT') out.verification = 'DATA_FAULT';
      else if (d && d.status === 'MARKET_FAULT') out.verification = 'MARKET_FAULT';
      else out.verification = d ? 'UNVERIFIED' : 'NOT_RUN';
    }
    /* where the market went relative to EdgeDesk since the open */
    if (B.move_since_open && B.move_since_open.points >= cfg.move_pts && out.toward) {
      var toward = B.move_since_open.toward === out.toward;
      out.market_direction = toward ? 'TOWARD' : 'AWAY';
      out.market_direction_text = 'The market moved ' + B.move_since_open.points.toFixed(1) + ' pts toward ' + B.move_since_open.toward_team
        + ' since the open — ' + (toward ? 'toward' : 'away from') + ' EdgeDesk.';
    } else if (B.move_since_open) {
      out.market_direction = 'FLAT';
      out.market_direction_text = 'The market is within ' + cfg.move_pts + ' pts of its open.';
    } else {
      out.market_direction_text = 'No opener was captured, so the market’s direction is unknown.';
    }
    /* disagreement quality: how much of the gap survives what EdgeDesk knows about itself */
    return out;
  };

  /* =================================================================
     D. WHY THIS NUMBER — the champion's own additive terms.
     b.terms = [{key,label,points,available,confidence,source}] — the
     engine's contributions, which sum to the raw margin, and
     b.calibration = {calibrated, promoted, slope, hfa} or null.
     Without terms: the V2.1 drivers are shown as the production pathway's
     own explanation, marked as a different model's, never blended.
     ================================================================= */
  T.TERM_TEXT = {
    rating: 'Team-strength edge (opponent-adjusted results, neutral field)',
    hfa: 'Home field', qb: 'Quarterback / personnel', matchup: 'Stylistic matchup',
    travel: 'Travel', schedule: 'Rest and schedule', injury: 'Reported availability',
    rivalry: 'Rivalry situational effect', conference: 'Conference strength'
  };
  T.DRIVER_TEXT = {
    elo_diff: 'Rating difference (Elo)', edge_epa: 'Efficiency edge (EPA)', match_mix_edge: 'Matchup mix',
    hfa: 'Home field', rest: 'Rest', qb: 'Quarterback'
  };
  T.decomposition = function (b, A) {
    var g = b.game || {};
    var out = { available: false, rows: [], raw_margin: null, final_margin: null, reconciles: null, basis: null, v2_drivers: null };
    if (!A.available) return out;
    var terms = (b.terms || []).filter(function (t) { return t && num(t.points) != null; });
    if (terms.length) {
      var order = ['rating', 'hfa', 'qb', 'injury', 'matchup', 'schedule', 'travel', 'conference', 'rivalry'];
      terms = terms.slice().sort(function (x, y) {
        var ix = order.indexOf(x.key), iy = order.indexOf(y.key);
        return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
      });
      var sum = 0;
      /* a term the engine prices at exactly zero today is not a reason: it is
         listed as NOT PRICED rather than drawn as "Team 0.0" */
      out.unpriced = terms.filter(function (t) { return t.points === 0; }).map(function (t) { return T.TERM_TEXT[t.key] || t.label || t.key; });
      terms = terms.filter(function (t) { return t.points !== 0; });
      terms.forEach(function (t) {
        sum += t.points;
        out.rows.push({ key: t.key, label: T.TERM_TEXT[t.key] || t.label || t.key, points: r2(t.points),
          favors: t.points > 0 ? g.home : (t.points < 0 ? g.away : null),
          text: (t.points > 0 ? g.home : g.away) + ' ' + signed(Math.abs(t.points)),
          available: t.available !== false, confidence: num(t.confidence), source: t.source || null, priced: t.points !== 0 });
      });
      out.raw_margin = r2(sum);
      var cal = b.calibration || null;
      out.calibration = cal && num(cal.calibrated) != null ? { adjustment: r2(cal.calibrated - sum), promoted: !!cal.promoted,
        text: cal.promoted ? 'Football-only calibration applied' : 'Football-only calibration computed but not promoted: shown, not applied',
        equation: cal.equation || null } : null;
      out.final_margin = r2(cal && cal.promoted && num(cal.calibrated) != null ? cal.calibrated : sum);
      out.reconciles = Math.abs(out.final_margin - A.home_margin) < 0.06;
      out.available = true;
      out.basis = 'the champion engine’s additive terms (projectGame contributions); they sum exactly to the raw margin';
      out.fair_text = A.fair_text;
    } else if (b.rating_split && num(b.rating_split.home) != null && num(b.rating_split.away) != null) {
      /* PARTIAL: the published team ratings give the neutral-field strength
         term exactly; everything else is the remainder, not itemised */
      var rt = b.rating_split.home - b.rating_split.away, rest = A.home_margin - rt;
      out.rows.push({ key: 'rating', label: T.TERM_TEXT.rating, points: r2(rt), favors: rt > 0 ? g.home : (rt < 0 ? g.away : null),
        text: (rt > 0 ? g.home : g.away) + ' ' + signed(Math.abs(rt)), available: true, confidence: null,
        source: 'published team ratings (' + g.home + ' ' + b.rating_split.home + ', ' + g.away + ' ' + b.rating_split.away + ')', priced: true });
      out.rows.push({ key: 'remainder', label: 'Home field + every other term (not itemised in this build)', points: r2(rest),
        favors: rest > 0 ? g.home : (rest < 0 ? g.away : null), text: (rest > 0 ? g.home : g.away) + ' ' + signed(Math.abs(rest)), available: true,
        confidence: null, source: 'fair margin minus the rating term', priced: true, remainder: true });
      out.raw_margin = r2(A.home_margin); out.final_margin = r2(A.home_margin); out.reconciles = true;
      out.available = true; out.partial = true;
      out.basis = 'partial: the neutral-field rating term from the published team ratings; the remainder (home field, QB, matchup, travel, rest, conference) is itemised from the next slate build, which publishes the engine’s terms';
      out.fair_text = A.fair_text;
    } else {
      out.reason = 'The champion’s term-by-term contributions were not published with this build (they are carried from the next slate build on).';
    }
    /* WHERE THE DISAGREEMENT SITS: holding every other term at EdgeDesk's
       value, the neutral-field strength edge the market's number implies */
    var rRow = out.rows.filter(function (r) { return r.key === 'rating'; })[0];
    if (rRow && b.market_margin != null) {
      var others = A.home_margin - rRow.points, implied = b.market_margin - others, fav = function (x) { return x > 0 ? g.home : g.away; };
      out.market_implied = { term: 'rating', edgedesk: r2(rRow.points), market_implied: r2(implied), difference: r2(rRow.points - implied),
        text: 'EdgeDesk rates ' + fav(rRow.points) + ' ' + Math.abs(rRow.points).toFixed(1) + ' pts better on a neutral field. Holding everything else at EdgeDesk’s values, the market’s number implies '
          + (Math.abs(implied) < 0.05 ? 'an even matchup' : fav(implied) + ' ' + Math.abs(implied).toFixed(1) + ' pts better') + ' — the disagreement sits in team strength unless the market is pricing something else.' };
    }
    if (b.v21 && b.v21.drivers && b.v21.drivers.length) {
      out.v2_drivers = { model: b.v21.model_version || 'edgedesk_cfb_v2.1.0',
        note: 'The production pathway (V2.1) explains its own, different number. Shown beside, never blended into, the champion’s.',
        rows: b.v21.drivers.map(function (d) {
          return { feature: d.feature, label: T.DRIVER_TEXT[d.feature] || d.feature, points: r2(d.points),
            favors: d.points > 0 ? g.home : (d.points < 0 ? g.away : null) };
        }) };
    }
    return out;
  };

  /* =================================================================
     F. PRICE — cover probability, break-even, EV, the price curve.
     b.dist.cover(marginLine) = the ENGINE's calibrated PMF:
       {win: P(home margin > line), push: P(= line), lose}
     ================================================================= */
  function sideProb(b, side, sideLine) {
    if (!b.dist || typeof b.dist.cover !== 'function' || num(sideLine) == null) return null;
    /* home covers a book line L if margin > -L; away covers +L if margin < L */
    var c = side === 'home' ? b.dist.cover(-sideLine) : b.dist.cover(sideLine);
    if (!c || num(c.win) == null) return null;
    var win = side === 'home' ? c.win : c.lose, push = num(c.push) || 0, lose = 1 - win - push;
    return { win: win, push: push, lose: lose, cover_no_push: (win + lose) > 0 ? win / (win + lose) : null };
  }
  T.sideProb = sideProb;
  function gradeEdge(e, cfg) {
    if (num(e) == null) return 'unpriced';
    if (e >= cfg.grade_strong_edge) return 'strong';
    if (e >= cfg.ideal_probability_edge) return 'acceptable';
    if (e >= cfg.min_probability_edge) return 'marginal';
    return 'pass';
  }
  T.gradeEdge = gradeEdge;
  function priceAt(b, side, line, price, cfg) {
    var p = sideProb(b, side, line);
    if (!p) return null;
    var be = breakEven(price);
    var e = ev(p.win, p.push, price);
    var edge = be == null || p.cover_no_push == null ? null : p.cover_no_push - be;
    return { line: line, price: price, cover: r4(p.cover_no_push), push: r4(p.push), win: r4(p.win), break_even: r4(be),
      edge: r4(edge), ev: r4(e), grade: gradeEdge(edge, cfg) };
  }
  T.priceView = function (b, A, B, C, cfg) {
    var g = b.game || {};
    var out = { available: false, side: null, team: null };
    if (!A.available) { out.reason = 'no projection to price'; return out; }
    if (!b.dist || typeof b.dist.cover !== 'function') { out.reason = 'the champion’s margin distribution is unavailable'; return out; }
    /* a stale quote is the last price EdgeDesk saw, not a price: nothing is priced off it */
    if (B.available && B.stale) { out.reason = 'the only quotes on file are stale (' + B.age_minutes + ' min old): no live price to evaluate'; return out; }
    /* the side: the one EdgeDesk likes more than the market; with no market,
       none (a price needs a price) */
    var side = C.available && C.toward ? C.toward : null;
    if (!side) { out.reason = C.available ? 'EdgeDesk matches the market: no side' : 'no market price to evaluate'; return out; }
    var team = side === 'home' ? g.home : g.away;
    out.side = side; out.team = team;
    var best = B.best && B.best[side];
    var ref = num(b.reference_price) != null ? b.reference_price : -110;
    var cur = best ? priceAt(b, side, best.line, best.price, cfg) : null;
    if (cur) { cur.book = best.book; cur.text = team + ' ' + bookText(best.line) + ' ' + priceText(best.price) + ' (' + best.book + ')'; }
    out.current = cur;
    /* the consensus number at the reference price, for context */
    var consLine = B.consensus_home_line == null ? null : (side === 'home' ? B.consensus_home_line : -B.consensus_home_line);
    out.at_consensus = consLine == null ? null : priceAt(b, side, consLine, ref, cfg);
    /* the price curve at the reference price, half points around the market */
    var center = best ? best.line : consLine, curve = [];
    if (center != null) {
      var c0 = Math.round(center * 2) / 2;
      for (var k = -cfg.curve_half_points; k <= cfg.curve_half_points; k++) {
        var L = c0 + k * 0.5, row = priceAt(b, side, L, ref, cfg);
        if (row) { row.text = team + ' ' + bookText(L) + ' ' + priceText(ref); row.is_current = best ? Math.abs(L - best.line) < 1e-9 : false; curve.push(row); }
      }
    }
    curve.sort(function (x, y) { return y.line - x.line; });                /* best number first */
    out.curve = curve;
    out.reference_price = ref;
    /* targets: the WORST line (fewest points) that still reaches a grade */
    function worst(minEdge) {
      var ok = curve.filter(function (r) { return num(r.edge) != null && r.edge >= minEdge; });
      if (!ok.length) return null;
      return ok.reduce(function (w, r) { return r.line < w.line ? r : w; });
    }
    var pref = worst(cfg.ideal_probability_edge), bet = worst(cfg.min_probability_edge);
    out.preferred_entry = pref ? { line: pref.line, price: ref, text: team + ' ' + bookText(pref.line) + ' ' + priceText(ref) + ' or better' } : null;
    out.bettable_to = bet ? { line: bet.line, price: ref, text: team + ' ' + bookText(bet.line) + ' ' + priceText(ref) } : null;
    out.pass_beyond = bet ? { line: bet.line - 0.5, text: team + ' ' + bookText(bet.line - 0.5) + ' or worse' } : null;
    /* the price floor at the CURRENT line: the worst price whose edge still clears the minimum */
    if (cur && cur.cover != null) {
      var needBe = cur.cover - cfg.min_probability_edge;
      if (needBe > 0 && needBe < 1) {
        var pay = (1 - needBe) / needBe;
        out.price_floor_at_current_line = pay >= 1 ? Math.round(100 * pay) : -Math.round(100 / pay);
      }
    }
    out.available = true;
    out.probability_basis = (b.dist && b.dist.basis) || null;
    out.model_probability_note = 'Model probability from the champion’s calibrated margin distribution. It is research: '
      + 'the decision engine has not validated a wagering calibration for this model (see the price decision).';
    return out;
  };

  /* cover probability at every half point from -30 to +30 around the side's
     number, a compact curve for the half-point table */
  T.coverCurve = function (b, side, center, cfg) {
    var rows = [];
    if (num(center) == null) return rows;
    var c0 = Math.round(center * 2) / 2;
    for (var k = -4; k <= 4; k++) {
      var L = c0 + k * 0.5, p = sideProb(b, side, L);
      if (p) rows.push({ line: L, cover: r4(p.cover_no_push), push: r4(p.push), text: bookText(L) });
    }
    rows.sort(function (x, y) { return y.line - x.line; });
    return rows;
  };

  /* =================================================================
     KEY NUMBERS — empirical CFB final-margin frequencies.
     b.key_mass = {3: 0.0926, 7: 0.0851, ...} (EDCfbP4Params
     distributions.abs_margin_key_mass: share of FBS games decided by
     exactly that margin). b.push_table = the decision calibration's
     measured push rates by line bucket, with n.
     ================================================================= */
  T.keyNumbers = function (b, B, F, cfg) {
    var km = b.key_mass || {}, out = { table: [], warnings: [], half_point: null };
    Object.keys(km).map(function (k) { return +k; }).filter(function (k) { return k > 0; }).sort(function (x, y) { return x - y; })
      .forEach(function (k) { out.table.push({ margin: k, share: r4(km[k]), text: pct(km[k], 1) + ' of games end on exactly ' + k }); });
    var top = out.table.slice().sort(function (x, y) { return y.share - x.share; }).slice(0, 4).map(function (x) { return x.margin; });
    out.primary = top;
    if (!F || !F.available || !F.current) return out;
    var L = F.current.line, aL = Math.abs(L), fl = Math.floor(aL), ce = Math.ceil(aL);
    /* the half point on the other side of the nearest key number */
    top.forEach(function (k) {
      if (Math.abs(aL - (k - 0.5)) < 1e-9 || Math.abs(aL - (k + 0.5)) < 1e-9 || Math.abs(aL - k) < 1e-9) {
        var better = L + 0.5, worse = L - 0.5;
        var a = sideProb(b, F.side, L), up = sideProb(b, F.side, better), dn = sideProb(b, F.side, worse);
        if (a && up && dn) {
          out.half_point = { key: k, current: L,
            gain_half_point: r4((up.win + 0.5 * up.push) - (a.win + 0.5 * a.push)),
            loss_half_point: r4((a.win + 0.5 * a.push) - (dn.win + 0.5 * dn.push)),
            text: F.team + ' ' + bookText(better) + ' vs ' + bookText(L) + ': ' + pp((up.win + 0.5 * up.push) - (a.win + 0.5 * a.push), 1)
              + ' of expected result, because ' + pct(km[k] || 0, 1) + ' of college games land exactly on ' + k + '.' };
        }
      }
    });
    /* the market moved THROUGH a key number since the open */
    if (B.open_home_line != null && B.consensus_home_line != null) {
      var o = Math.abs(B.open_home_line), c = Math.abs(B.consensus_home_line);
      top.forEach(function (k) {
        if ((o < k && c > k) || (o > k && c < k) || ((o === k) !== (c === k) && Math.min(o, c) <= k && Math.max(o, c) >= k)) {
          out.warnings.push({ key: k, text: 'The market moved through ' + k + ' (open ' + bookTextExact(-B.open_home_line)
            + ' → now ' + bookTextExact(-B.consensus_home_line) + ' for ' + (b.game || {}).home + '): '
            + pct(km[k] || 0, 1) + ' of college games are decided by exactly ' + k + ', so this move matters more than its size.' });
        }
      });
    }
    out.basis = 'EDCfbP4Params.distributions.abs_margin_key_mass: the share of FBS games decided by exactly each margin; the cover probabilities above come from the champion’s margin PMF, which carries the same key-number shape';
    return out;
  };

  /* =================================================================
     LINE SHOPPING — every fresh quote, priced by the model, with the
     book-price edge kept apart from the model edge.
     ================================================================= */
  T.lineShopping = function (b, A, B, C, F, cfg) {
    var out = { available: false, rows: [], single_book: false, model_edge: null, book_edge: null };
    if (!B.available) return out;
    var side = F && F.side ? F.side : null;
    var cons = B.consensus_home_line;
    out.rows = B.quotes.map(function (q) {
      var r = { book: q.book, source: q.source, home_line: q.home_line, price_home: q.price_home, price_away: q.price_away,
        observed_at: q.observed_at, age_minutes: q.age_minutes, fresh: q.fresh, ev_home: null, ev_away: null, stale_candidate: false };
      var h = priceAt(b, 'home', q.home_line, q.price_home, cfg), a = priceAt(b, 'away', -q.home_line, q.price_away, cfg);
      r.ev_home = h ? h.ev : null; r.ev_away = a ? a.ev : null;
      r.edge_home = h ? h.edge : null; r.edge_away = a ? a.edge : null;
      if (cons != null && Math.abs(q.home_line - cons) >= 1 && q.fresh) {
        r.stale_candidate = true;
        r.stale_note = 'this book is ' + Math.abs(q.home_line - cons).toFixed(1) + ' pts off the consensus — check before trusting it';
      }
      return r;
    });
    out.single_book = B.books_fresh <= 1;
    out.note = out.single_book ? 'Only one sportsbook has a fresh quote: there is no line shopping to compare, and no consensus beyond that book.' : null;
    if (C.available && side) {
      var best = B.best && B.best[side];
      out.model_edge = { points: C.points, text: 'EdgeDesk vs consensus: ' + C.points.toFixed(1) + ' pts toward ' + C.toward_team };
      if (best && cons != null) {
        var consSide = side === 'home' ? cons : -cons, bookEdge = best.line - consSide;
        out.book_edge = { points: r2(bookEdge), book: best.book,
          text: best.book + ' vs consensus: ' + (Math.abs(bookEdge) < 0.05 ? 'same number' : Math.abs(bookEdge).toFixed(1) + ' pts ' + (bookEdge > 0 ? 'better' : 'worse') + ' for ' + F.team) };
        out.edge_kind = bookEdge >= 1 && C.points < cfg.research_gap ? 'BOOK_PRICE_EDGE'
          : (C.points >= cfg.research_gap && bookEdge < 1 ? 'MODEL_EDGE' : (bookEdge >= 1 ? 'BOTH' : 'NONE'));
        out.edge_kind_text = {
          BOOK_PRICE_EDGE: 'This is a stale-book price edge, not a football disagreement: one book is off the market while EdgeDesk roughly agrees with the consensus.',
          MODEL_EDGE: 'This is a model edge: EdgeDesk disagrees with the whole market, not with one book.',
          BOTH: 'Both: EdgeDesk disagrees with the market and one book is further off the consensus still.',
          NONE: 'Neither a model edge nor a book-price edge of a point or more.'
        }[out.edge_kind];
      }
    }
    out.available = true;
    return out;
  };

  /* =================================================================
     MODEL CONSENSUS — independent numbers, agreement from DISPERSION.
     b.models = [{key, label, family, home_margin, role, independent}]
     ================================================================= */
  T.consensus = function (b, A, C, cfg) {
    var g = b.game || {}, rows = (b.models || []).filter(function (m) { return m && num(m.home_margin) != null; });
    var out = { available: false, rows: [], sd: null, range: null, agreement: null, why_disagree: [] };
    if (rows.length < 2) { out.reason = 'fewer than two model numbers exist for this game'; return out; }
    var mkt = C.available ? C.market_margin : null;
    out.rows = rows.map(function (m) {
      return { key: m.key, label: m.label, family: m.family || null, role: m.role || null, independent: m.independent !== false,
        home_margin: r2(m.home_margin), text: marginLine(m.home_margin, g.home, g.away, 1),
        vs_market: mkt == null ? null : r2(m.home_margin - mkt),
        side_vs_market: mkt == null ? null : (m.home_margin - mkt > 0.5 ? 'home' : (m.home_margin - mkt < -0.5 ? 'away' : 'market')) };
    });
    var ind = out.rows.filter(function (r) { return r.independent; });
    var xs = ind.map(function (r) { return r.home_margin; });
    var s = sd(xs);
    out.sd = r2(s); out.n_independent = ind.length;
    out.range = r2(Math.max.apply(null, xs) - Math.min.apply(null, xs));
    out.mean = r2(xs.reduce(function (a, x) { return a + x; }, 0) / xs.length);
    var tier = s == null ? null : (s < cfg.agree_high_sd ? 'HIGH' : (s < cfg.agree_moderate_sd ? 'MODERATE' : 'LOW'));
    /* a 0-100 score from dispersion alone: 100 at SD 0, 0 at the policy's
       max_ensemble_sd — never a count of models on one side */
    out.agreement = { tier: tier, score: s == null ? null : Math.round(100 * clamp(1 - s / cfg.max_model_sd, 0, 1)),
      basis: 'the standard deviation of ' + ind.length + ' independent model numbers (' + (s == null ? '—' : s.toFixed(1)) + ' pts); '
        + 'HIGH under ' + cfg.agree_high_sd + ', MODERATE under ' + cfg.agree_moderate_sd + ', 0 at ' + cfg.max_model_sd + ' (the policy’s disagreement limit)' };
    if (C.available && C.toward) {
      var same = ind.filter(function (r) { return r.side_vs_market === C.toward; }).length;
      var opp = ind.filter(function (r) { return r.side_vs_market && r.side_vs_market !== C.toward && r.side_vs_market !== 'market'; }).length;
      out.side_support = { same: same, opposite: opp, n: ind.length,
        text: same + ' of ' + ind.length + ' independent models sit on ' + C.toward_team + '’s side of the market; ' + opp + ' on the other side' };
    }
    /* WHY THE MODELS DISAGREE — only what the components themselves say */
    var byKey = {};
    out.rows.forEach(function (r) { byKey[r.key] = r; });
    var v1 = byKey.v1, rid = byKey.v21_ridge, gbm = byKey.v21_gbm, ens = byKey.v21;
    if (rid && gbm && Math.abs(rid.home_margin - gbm.home_margin) >= 1.5) {
      var hi = rid.home_margin > gbm.home_margin ? rid : gbm, lo = hi === rid ? gbm : rid;
      out.why_disagree.push('The ' + (hi === gbm ? 'gradient-boosted matchup model (D_gbm)' : 'ridge efficiency model (C_ridge)')
        + ' is ' + Math.abs(hi.home_margin - lo.home_margin).toFixed(1) + ' pts more favourable to ' + g.home + ' than the '
        + (hi === gbm ? 'ridge model' : 'matchup model') + ': the non-linear matchup features and the linear efficiency features read this game differently.');
    }
    if (v1 && ens && Math.abs(v1.home_margin - ens.home_margin) >= 1.5) {
      var diff = v1.home_margin - ens.home_margin;
      var topTerm = (b.terms || []).filter(function (t) { return num(t.points) != null; })
        .sort(function (x, y) { return Math.abs(y.points) - Math.abs(x.points); })[0];
      var topDrv = b.v21 && b.v21.drivers && b.v21.drivers.length ? b.v21.drivers.slice().sort(function (x, y) { return Math.abs(y.points) - Math.abs(x.points); })[0] : null;
      out.why_disagree.push('The champion (V1) is ' + Math.abs(diff).toFixed(1) + ' pts more favourable to ' + (diff > 0 ? g.home : g.away)
        + ' than V2.1.' + (topTerm ? ' V1’s largest term is ' + (T.TERM_TEXT[topTerm.key] || topTerm.key).toLowerCase() + ' (' + signed(topTerm.points) + ' toward ' + (topTerm.points > 0 ? g.home : g.away) + ').' : '')
        + (topDrv ? ' V2.1’s largest driver is ' + (T.DRIVER_TEXT[topDrv.feature] || topDrv.feature).toLowerCase() + ' (' + signed(Math.abs(topDrv.points)) + ' toward ' + (topDrv.points > 0 ? g.home : g.away) + ').' : '')
        + ' V1 prices opponent-adjusted results with a preseason prior; V2.1 is a stacked ridge + boosted-tree model on rating and efficiency features.');
    }
    if (!out.why_disagree.length) out.why_disagree.push(tier === 'HIGH' ? 'The models cluster tightly: there is no material disagreement to explain.' : 'The spread across models is not traceable to one component.');
    out.available = true;
    return out;
  };

  /* =================================================================
     SENSITIVITY — how the fair line moves if an uncertain input moves.
     Every row is an actual production component:
       b.stability.dimensions  the champion's own perturbation SDs
                               (lib/cfb_reliability.js, 64 scenarios)
       b.v2params              the V2.1 overlays: the measured starter-change
                               level effect, weather and availability variance
     ================================================================= */
  T.sensitivity = function (b, A, cfg) {
    var g = b.game || {}, out = { available: false, rows: [], basis: [] };
    if (!A.available) return out;
    var base = A.home_margin;
    function row(key, label, delta, basis, kind, sigmaDelta) {
      var m = base + delta;
      out.rows.push({ key: key, label: label, delta: r2(delta), home_margin: r2(m), fair_text: marginLine(m, g.home, g.away, 1),
        sigma_delta: sigmaDelta == null ? null : r2(sigmaDelta), basis: basis, kind: kind || 'mean' });
    }
    var dims = (b.stability && b.stability.dimensions) || [];
    dims.forEach(function (d) {
      if (!d || num(d.sigma) == null) return;
      if (d.key === 'rating_home') { row('rating_home_down', g.home + ' rating 1 SD weaker', -d.sigma, 'the champion’s rating uncertainty for ' + g.home + ' (±' + d.sigma.toFixed(2) + ' pts, stability scenarios)'); row('rating_home_up', g.home + ' rating 1 SD stronger', d.sigma, 'same'); }
      if (d.key === 'rating_away') { row('rating_away_down', g.away + ' rating 1 SD weaker', d.sigma, 'the champion’s rating uncertainty for ' + g.away + ' (±' + d.sigma.toFixed(2) + ' pts, stability scenarios)'); row('rating_away_up', g.away + ' rating 1 SD stronger', -d.sigma, 'same'); }
      if (d.key === 'hfa' && !g.neutral_site) row('hfa_down', 'Home field 1 SD smaller', -d.sigma, 'the champion’s home-field uncertainty (±' + d.sigma.toFixed(2) + ' pts)');
    });
    var P = b.v2params || null;
    if (P && P.qb && num(P.qb.change_delta_pts) != null && num(P.qb.baseline_same_starter) != null) {
      var d0 = P.qb.change_delta_pts, p0 = P.qb.baseline_same_starter;
      var sp = (P.qb_common && P.qb_common.status_start_prob) || {};
      ['home', 'away'].forEach(function (s) {
        var team = s === 'home' ? g.home : g.away, sign = s === 'home' ? 1 : -1;
        var qbn = b.qb && b.qb[s] && b.qb[s].player ? b.qb[s].player : 'the expected starter';
        /* level model: mean shift = (p0 - p_status) x delta */
        var out0 = (p0 - (num(sp.out) != null ? sp.out : 0)) * d0 * sign;
        var conf = (p0 - (num(sp.confirmed) != null ? sp.confirmed : 0.99)) * d0 * sign;
        row('qb_out_' + s, team + ': ' + qbn + ' OUT', out0, 'V2.1’s measured starter-change effect (' + d0.toFixed(2) + ' pts, 95% CI '
          + (P.qb.change_delta_ci ? P.qb.change_delta_ci.map(function (x) { return x.toFixed(1); }).join(' to ') : '—') + ', n=' + (P.qb.n_changes_dev || '—') + ' changes, 2016-2023), applied relative to the ' + Math.round(p0 * 100) + '% baseline', 'qb');
        row('qb_confirmed_' + s, team + ': ' + qbn + ' CONFIRMED', conf, 'same effect at the confirmed start probability (' + (sp.confirmed != null ? sp.confirmed : 0.99) + ')', 'qb');
      });
      out.basis.push('Quarterback rows use V2.1’s measured starter-change level effect; the champion V1 prices no quarterback term today, so these show what the production pathway’s measured effect would do to EdgeDesk’s number.');
    }
    if (P && P.weather && num(P.weather.var_pts_per_wind_mph) != null) {
      var w = P.weather, th = w.wind_threshold_mph || 15;
      [15, 25].forEach(function (wind) {
        var extra = w.var_pts_per_wind_mph * Math.max(0, wind - th);
        var s0 = num(A.sigma) || 15, s1 = Math.sqrt(s0 * s0 + extra * extra);
        row('wind_' + wind, 'Wind ' + wind + ' mph', 0, 'weather moves no spread in production (V1: totals only; V2.1: widens the range only, ' + (w.points_applied ? 'mean applied' : 'mean NOT applied') + ')', 'variance', s1 - s0);
      });
    }
    if (P && P.injury && num(P.injury.var_pts_per_unit) != null) {
      /* one of five linemen out: usage share 0.2 of the OL unit, through the
         same saturating cap engine.js injuryOverlay applies */
      var I = P.injury, capOL = (I.unit_caps && I.unit_caps.OL) || 0.6, lost = capOL * (1 - Math.exp(-0.2 / capOL));
      var tc = I.team_cap || 1.5, tot = tc * (1 - Math.exp(-lost / tc)), sdPts = I.var_pts_per_unit * tot;
      var s0b = num(A.sigma) || 15;
      row('ol_starter_out', 'A starting offensive lineman out (either team)', 0, 'availability widens the range and never moves the mean (params.injury.points_applied = ' + !!I.points_applied + '): one of five OL starters', 'variance', Math.sqrt(s0b * s0b + sdPts * sdPts) - s0b);
    }
    out.available = out.rows.length > 0;
    if (!out.available) out.reason = 'no measured uncertainty dimensions were published for this game';
    return out;
  };

  /* =================================================================
     WHAT WOULD HAVE TO BE WRONG FOR THE MARKET TO BE RIGHT
     Each uncertain input, with its own measured SD, asked to absorb the
     whole gap: the fewer SDs it needs, the more plausible it is as the
     reconciliation. Ranked, never presented as equally likely.
     ================================================================= */
  T.reconcile = function (b, A, C, K, cfg) {
    var g = b.game || {}, out = { available: false, rows: [] };
    if (!A.available || !C.available || C.points < cfg.research_gap) {
      out.reason = !C.available ? 'no market to reconcile with' : 'EdgeDesk and the market are inside the research threshold: nothing to reconcile';
      return out;
    }
    var gap = C.points, team = C.toward_team, other = C.toward === 'home' ? g.away : g.home;
    function add(key, text, sdv, source, need) {
      var needed = need == null ? gap : need;
      out.rows.push({ key: key, text: text, points_needed: r2(needed), sd: r2(sdv),
        sds_needed: num(sdv) && sdv > 0 ? r2(needed / sdv) : null, source: source });
    }
    var dims = (b.stability && b.stability.dimensions) || [];
    dims.forEach(function (d) {
      if (!d || !(num(d.sigma) > 0)) return;
      if (d.key === 'rating_home') add('rating_home', (C.toward === 'home' ? g.home + ' is ' : g.home + ' is ') + gap.toFixed(1) + ' pts ' + (C.toward === 'home' ? 'weaker' : 'stronger') + ' than EdgeDesk’s rating', d.sigma, 'champion rating uncertainty');
      if (d.key === 'rating_away') add('rating_away', g.away + ' is ' + gap.toFixed(1) + ' pts ' + (C.toward === 'away' ? 'weaker' : 'stronger') + ' than EdgeDesk’s rating', d.sigma, 'champion rating uncertainty');
      if (d.key === 'hfa' && !g.neutral_site && C.toward === 'home') add('hfa', 'home field is worth ' + gap.toFixed(1) + ' pts less here', d.sigma, 'champion home-field uncertainty');
    });
    /* all the measured dimensions at once, in proportion */
    var joint = Math.sqrt(dims.reduce(function (s, d) { return s + (num(d.sigma) ? d.sigma * d.sigma : 0); }, 0));
    if (joint > 0) add('combination', 'a combination of the rating and home-field errors above, shared in proportion', joint, 'all measured dimensions jointly');
    /* the quarterback, when a starter is not confirmed */
    var P = b.v2params;
    if (P && P.qb && num(P.qb.change_delta_pts) != null) {
      var qbSide = C.toward, q = b.qb && b.qb[qbSide];
      if (q && q.status && !q.confirmed) {
        var eff = Math.abs(P.qb.change_delta_pts);
        out.rows.push({ key: 'qb', text: team + '’s expected quarterback (' + (q.player || 'unnamed') + ') does not start: the measured effect is ' + eff.toFixed(1) + ' pts, which covers ' + Math.round(100 * Math.min(1, eff / gap)) + '% of the gap',
          points_needed: r2(gap), sd: null, sds_needed: null, covers_share: r2(Math.min(1, eff / gap)), source: 'V2.1 measured starter-change effect; ' + team + ' QB status ' + q.status });
      }
    }
    /* a priced term that is simply not real: how much of the gap it holds */
    (b.terms || []).forEach(function (t) {
      if (!t || num(t.points) == null || t.key === 'rating' || t.key === 'hfa') return;
      var toward = (t.points > 0 && C.toward === 'home') || (t.points < 0 && C.toward === 'away');
      if (!toward || Math.abs(t.points) < 0.5) return;
      out.rows.push({ key: 'term_' + t.key, text: 'the ' + (T.TERM_TEXT[t.key] || t.key).toLowerCase() + ' term (' + Math.abs(t.points).toFixed(1) + ' pts toward ' + team + ') is not real: it holds ' + Math.round(100 * Math.min(1, Math.abs(t.points) / gap)) + '% of the gap',
        points_needed: r2(Math.abs(t.points)), sd: null, sds_needed: null, covers_share: r2(Math.min(1, Math.abs(t.points) / gap)), source: 'the champion’s additive term' + (num(t.confidence) != null ? ' (measured with ' + Math.round(100 * t.confidence) + '% confidence)' : '') });
    });
    /* the baseline: EdgeDesk is simply wrong on this game by ordinary error */
    if (num(b.expected_abs_error) != null) {
      out.baseline = { points_needed: r2(gap), typical_miss: r2(b.expected_abs_error), share_of_typical_miss: r2(gap / b.expected_abs_error),
        text: 'For scale: the whole gap is ' + Math.round(100 * gap / b.expected_abs_error) + '% of EdgeDesk’s typical miss on a game like this (' + b.expected_abs_error.toFixed(1) + ' pts). Ordinary model error alone could produce it; the rows above name the specific assumptions that would have to break.' };
    }
    /* another EdgeDesk model already sits closer to the market */
    if (K && K.available) {
      var closer = K.rows.filter(function (r) { return r.key !== 'v1' && r.vs_market != null && Math.abs(r.vs_market) < gap - 1; })
        .sort(function (x, y) { return Math.abs(x.vs_market) - Math.abs(y.vs_market); })[0];
      if (closer) out.rows.push({ key: 'cross_model', text: closer.label + ' already sits ' + Math.abs(closer.vs_market).toFixed(1) + ' pts from the market (' + closer.text + '): the champion’s specific assumptions account for ' + (gap - Math.abs(closer.vs_market)).toFixed(1) + ' pts of the gap',
        points_needed: r2(gap - Math.abs(closer.vs_market)), sd: null, sds_needed: null, source: 'model consensus' });
    }
    out.rows.sort(function (x, y) {
      var a = x.sds_needed == null ? 99 : x.sds_needed, c = y.sds_needed == null ? 99 : y.sds_needed;
      return a - c;
    });
    out.gap = gap; out.toward_team = team; out.other_team = other;
    out.headline = 'EdgeDesk ' + A.fair_text + ' · market ' + (C.market_margin != null ? marginLine(C.market_margin, g.home, g.away, 1) : '—') + ' · gap ' + gap.toFixed(1) + ' pts toward ' + team;
    out.note = 'Ranked by how many standard deviations of each input’s OWN measured uncertainty the market’s number requires. Fewer is more plausible. They are not equally likely, and none is known to be the cause.';
    out.available = out.rows.length > 0 || !!out.baseline;
    return out;
  };

  /* =================================================================
     E. RISKS — what could make EdgeDesk wrong
     ================================================================= */
  T.risks = function (b, A, C, K, cfg) {
    var g = b.game || {}, items = [];
    function add(key, sev, text, source) { items.push({ key: key, severity: sev, text: text, source: source || null }); }
    if (A.available && num(b.expected_abs_error) != null)
      add('model_uncertainty', 'context', 'EdgeDesk’s typical miss on a game like this is ' + b.expected_abs_error.toFixed(1) + ' pts (80% range ' + (A.interval_80 ? A.interval_80.text : '—') + ').', 'expected absolute error / margin distribution');
    ['home', 'away'].forEach(function (s) {
      var q = b.qb && b.qb[s], team = s === 'home' ? g.home : g.away;
      if (!q) { add('qb_' + s, 'high', team + ': no starting quarterback identified.', 'starter context'); return; }
      if (q.contested) add('qb_' + s, 'high', team + ': the quarterback job is contested (' + String(q.label || q.status).replace(/[.\s]+$/, '') + ').', q.source);
      else if (!q.confirmed) add('qb_' + s, 'moderate', team + ': ' + (q.player || 'the starter') + ' is expected, not confirmed (' + String(q.status || 'unknown').toLowerCase().replace(/_/g, ' ') + ').', q.source);
    });
    var av = b.availability || {};
    ['home', 'away'].forEach(function (s) {
      var a = av[s], team = s === 'home' ? g.home : g.away;
      if (a && a.state && a.state !== 'USABLE' && a.state !== 'KNOWN') add('availability_' + s, 'moderate', team + ': availability ' + String(a.state).toLowerCase().replace(/_/g, ' ') + (a.why ? ' — ' + a.why : '') + '.', 'availability feed');
    });
    if (K && K.available && K.agreement && K.agreement.tier === 'LOW') add('model_disagreement', 'high', 'EdgeDesk’s own models disagree (SD ' + K.sd.toFixed(1) + ' pts across ' + K.n_independent + ' models).', 'model consensus');
    var gp = b.games_played || {};
    if (num(gp.min) != null && gp.min < 3) add('thin_opponent_data', 'moderate', 'Only ' + gp.min + ' current-season game' + (gp.min === 1 ? '' : 's') + ' behind the thinner rating; much of it is still last season carried forward.', 'rating sample');
    if (g.fcs) add('fcs', 'high', 'An FCS team is involved: its rating is translated across divisions and is far less reliable.', 'division');
    if (g.cross_conference) add('cross_conference', 'context', 'Cross-conference game: the two ratings are linked only through non-conference results, a thinner bridge.', 'schedule');
    if (b.stability && num(b.stability.favorite_flip_rate) != null && b.stability.favorite_flip_rate >= 0.1)
      add('favorite_flip', 'moderate', 'The projected favourite flips in ' + Math.round(100 * b.stability.favorite_flip_rate) + '% of EdgeDesk’s own perturbation scenarios.', 'projection stability');
    if (C.available && C.class === 'MAJOR' && C.integrity && C.integrity.failed.length)
      C.integrity.failed.slice(0, 2).forEach(function (f, i) { add('integrity_' + i, 'high', 'Integrity check failed: ' + f + '.', 'integrity gate'); });
    (b.extreme || []).forEach(function (e, i) { add('extreme_' + i, 'moderate', e, 'component range check'); });
    (b.uncertainty_drivers || []).forEach(function (u, i) { add('v2_unc_' + i, 'context', 'V2.1 flags: ' + u + '.', 'V2.1 uncertainty drivers'); });
    var order = { high: 0, moderate: 1, context: 2 };
    items.sort(function (x, y) { return order[x.severity] - order[y.severity]; });
    return { items: items, high: items.filter(function (i) { return i.severity === 'high'; }).length };
  };

  /* =================================================================
     DATA QUALITY and TRUST — shown, never folded into a probability
     ================================================================= */
  T.dataQuality = function (b, B) {
    var r = b.reliability || {}, g = b.game || {};
    var rows = ((b.data_coverage && b.data_coverage.rows) || []).filter(function (x) { return x.key !== 'market'; }).map(function (x) {
      return { key: x.key, label: x.label, value: x.value, unit: x.unit || null, detail: x.detail || null };
    });
    if (B) rows.push({ key: 'market', label: 'Market', value: B.available ? B.books_fresh + ' fresh book' + (B.books_fresh === 1 ? '' : 's') : 'none', unit: null,
      detail: B.available ? (B.stale ? 'only stale quotes (' + B.age_minutes + ' min old)' : 'newest quote ' + B.age_minutes + ' min old') : 'no quote captured' });
    return {
      reliability: num(r.score), grade: r.grade || null, main_deduction: r.main_deduction || null,
      next_actions: (r.next_actions || []).slice(0, 3),
      rows: rows,
      fcs_note: g.fcs ? 'An FCS team is on this card. EdgeDesk translates FCS results onto the FBS scale with far fewer games, so the rating, the reliability and every probability here carry more error than an FBS game’s.' : null,
      separate: 'Data quality says how complete the inputs are. It is not a probability, and a complete game is not more likely to cover.'
    };
  };
  T.trust = function (b, B) {
    var t = b.trust || {};
    return {
      model_updated_at: t.model_updated_at || null, market_updated_at: B.as_of || null,
      market_age_minutes: B.age_minutes, qb_as_of: t.qb_as_of || null, roster_as_of: t.roster_as_of || null,
      books: B.books_fresh, books_total: B.books_total, model_version: (b.model || {}).model_version || null,
      model_label: (b.model || {}).label || null, degraded: t.degraded || null,
      decision_policy: t.decision_policy || null, betting_enabled: !!t.betting_enabled,
      warnings: (t.warnings || []).slice()
    };
  };

  /* =================================================================
     MATCHUP INTELLIGENCE — continuous, opponent-adjusted unit metrics
     b.metrics = {home: team metrics, away: team metrics}
     (football/matchup/metrics.json: z > 0 = better than the league for that
     unit, whichever direction the raw rate runs)
     ================================================================= */
  function unitZ(t, group) { var u = t && t.performance && t.performance.sub_units && t.performance.sub_units[group]; return u && num(u.z) != null ? u : null; }
  function detail(t, side, id) {
    var L = t && t.performance && t.performance[side + '_detail'] && t.performance[side + '_detail'].used;
    if (!L) return null;
    for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i];
    return null;
  }
  T.MATCHUP_CATEGORIES = [
    { key: 'PASS', label: 'Pass game', off: ['sub', 'pass_offense'], def: ['sub', 'pass_defense'], show: [['offense', 'yards_per_attempt', 'YPA', 1], ['offense', 'explosive_pass_rate', 'explosive pass', 'pct'], ['defense', 'def_yards_per_attempt', 'YPA allowed', 1]] },
    { key: 'RUSH', label: 'Run game', off: ['sub', 'run_offense'], def: ['sub', 'run_defense'], show: [['offense', 'yards_per_rush', 'YPC', 1], ['defense', 'def_yards_per_rush', 'YPC allowed', 1]] },
    { key: 'TRENCHES', label: 'Trenches', off: ['ids', ['sack_rate_allowed', 'stuff_rate']], def: ['ids', ['def_sack_rate', 'def_stuff_rate']], show: [['offense', 'sack_rate_allowed', 'sacks allowed', 'pct'], ['defense', 'def_sack_rate', 'sack rate', 'pct']] },
    { key: 'EXPLOSIVENESS', label: 'Explosive plays', off: ['ids', ['explosive_pass_rate', 'explosive_rush_rate']], def: ['ids', ['def_explosive_pass_allowed', 'def_explosive_rush_allowed']], show: [['offense', 'explosive_pass_rate', 'explosive pass', 'pct'], ['offense', 'explosive_rush_rate', 'explosive rush', 'pct']] },
    { key: 'EARLY_DOWNS', label: 'Early downs', off: ['ids', ['early_down_success']], def: ['ids', ['def_early_down_allowed']], show: [['offense', 'early_down_success', 'early-down success', 'pct']] },
    { key: 'FINISHING', label: 'Finishing drives', off: ['ids', ['rz_success']], def: ['ids', ['def_rz_allowed']], show: [['offense', 'rz_success', 'red-zone success', 'pct'], ['defense', 'def_rz_allowed', 'red-zone allowed', 'pct']] },
    { key: 'BALL_SECURITY', label: 'Turnovers', off: ['ids', ['turnover_rate']], def: ['ids', ['def_turnovers_forced']], show: [['offense', 'turnover_rate', 'giveaway rate', 'pct'], ['defense', 'def_turnovers_forced', 'takeaway rate', 'pct']] }
  ];
  T.NOT_MEASURED = ['havoc rate', 'QB mobility', 'pace (plays per game)'];
  function sideScore(t, spec) {
    if (!t) return null;
    if (spec[0] === 'sub') {
      var u = unitZ(t, spec[1]);
      if (!u) return null;
      var used = u.used || [], rel = used.length ? used.reduce(function (s, x) { return s + (num(x.reliability) || 0); }, 0) / used.length : null;
      var n = used.length ? Math.min.apply(null, used.map(function (x) { return num(x.n) || 0; })) : null;
      return { z: u.z, rel: rel, n: n };
    }
    var zs = [], rels = [], ns = [];
    spec[1].forEach(function (id) {
      var d = detail(t, id.indexOf('def_') === 0 ? 'defense' : 'offense', id);
      if (d && num(d.z) != null) { zs.push(d.z); rels.push(num(d.reliability) || 0); ns.push(num(d.n) || 0); }
    });
    if (!zs.length) return null;
    return { z: zs.reduce(function (s, x) { return s + x; }, 0) / zs.length, rel: rels.reduce(function (s, x) { return s + x; }, 0) / rels.length, n: Math.min.apply(null, ns) };
  }
  T.matchupCards = function (b) {
    var g = b.game || {}, M = b.metrics || {}, H = M.home, W = M.away, cards = [];
    if (!H || !W) return { available: false, cards: [], reason: 'opponent-adjusted unit metrics are not published for both teams', not_measured: T.NOT_MEASURED };
    T.MATCHUP_CATEGORIES.forEach(function (cat) {
      var hO = sideScore(H, cat.off), aD = sideScore(W, cat.def), aO = sideScore(W, cat.off), hD = sideScore(H, cat.def);
      if (!hO || !aD || !aO || !hD) return;
      /* each offence against the other defence, in league SDs; the card is
         the difference between the two mismatches */
      var homeEdge = hO.z - aD.z, awayEdge = aO.z - hD.z, net = homeEdge - awayEdge;
      var rel = Math.min(hO.rel, aD.rel, aO.rel, hD.rel), n = Math.min(hO.n || 0, aD.n || 0, aO.n || 0, hD.n || 0);
      var conf = rel >= 0.9 && n >= 60 ? 'HIGH' : (rel >= 0.75 && n >= 30 ? 'MODERATE' : 'LOW');
      var mag = Math.abs(net) >= 1.5 ? 'large' : (Math.abs(net) >= 0.75 ? 'moderate' : (Math.abs(net) >= 0.3 ? 'small' : 'even'));
      var values = [];
      cat.show.forEach(function (s) {
        [['home', H], ['away', W]].forEach(function (pair) {
          var d = detail(pair[1], s[0], s[1]);
          if (d && num(d.adjusted) != null) values.push({ team: pair[0] === 'home' ? g.home : g.away, metric: s[2],
            value: s[3] === 'pct' ? pct(d.adjusted, 1) : d.adjusted.toFixed(s[3]), league: s[3] === 'pct' ? pct(d.league, 1) : (num(d.league) != null ? d.league.toFixed(s[3]) : null), n: r1(d.n) });
        });
      });
      cards.push({ key: cat.key, label: cat.label, favors: mag === 'even' ? null : (net > 0 ? g.home : g.away),
        favors_side: mag === 'even' ? null : (net > 0 ? 'home' : 'away'),
        magnitude: mag, net_sd: r2(net), home_edge_sd: r2(homeEdge), away_edge_sd: r2(awayEdge), confidence: conf,
        sample_min: Math.round(n), values: values,
        text: mag === 'even' ? 'Even' : (net > 0 ? g.home : g.away) + ' · ' + mag + ' (' + Math.abs(net).toFixed(2) + ' SD)' });
    });
    return { available: cards.length > 0, cards: cards, not_measured: T.NOT_MEASURED,
      basis: 'opponent-adjusted unit metrics (football/matchup/metrics.json): each offence against the other defence in league standard deviations. Context: the champion prices matchup only through its own stylistic-matchup term.' };
  };

  /* =================================================================
     PATH TO COVER / PATH TO FAILURE — measurable conditions, never a
     prediction. From the distribution, the matchup cards, the components
     and the reconciliation.
     ================================================================= */
  T.paths = function (b, A, F, M, R, cfg) {
    var g = b.game || {}, out = { available: false, cover: [], failure: [] };
    if (!A.available || !F.available || !F.current) return out;
    var side = F.side, team = F.team, opp = side === 'home' ? g.away : g.home, line = F.current.line;
    var need = -line;                     /* the side must win by more than this (negative = can lose by less) */
    var sideMargin = side === 'home' ? A.home_margin : -A.home_margin;
    out.cover.push(team + ' has to ' + (need > 0 ? 'win by more than ' + need.toFixed(1) : (need < 0 ? 'lose by less than ' + Math.abs(need).toFixed(1) + ' (or win)' : 'win')) + '. EdgeDesk’s median is '
      + (sideMargin >= 0 ? team + ' by ' + sideMargin.toFixed(1) : opp + ' by ' + Math.abs(sideMargin).toFixed(1)) + '; the model gives it ' + pct(F.current.cover, 1) + ' (pushes aside).');
    var cards = (M && M.cards) || [];
    cards.filter(function (c) { return c.favors_side === side && c.magnitude !== 'even'; }).slice(0, 3).forEach(function (c) {
      out.cover.push('Hold the ' + c.label.toLowerCase() + ' edge (' + c.magnitude + ', ' + Math.abs(c.net_sd).toFixed(2) + ' SD'
        + (c.values.length ? '; ' + c.values.filter(function (v) { return v.team === team; }).slice(0, 2).map(function (v) { return v.metric + ' ' + v.value; }).join(', ') : '') + ').');
    });
    cards.filter(function (c) { return c.favors_side && c.favors_side !== side && c.magnitude !== 'even'; }).slice(0, 3).forEach(function (c) {
      out.failure.push(opp + '’s ' + c.label.toLowerCase() + ' edge plays to form or better (' + c.magnitude + ', ' + Math.abs(c.net_sd).toFixed(2) + ' SD).');
    });
    if (R && R.available) R.rows.slice(0, 2).forEach(function (r) { out.failure.push('The market is right because ' + r.text + (r.sds_needed != null ? ' (' + r.sds_needed.toFixed(1) + ' SD of that input)' : '') + '.'); });
    var q = A.quantiles || {};
    if (num(q.p25) != null) {
      var p25 = side === 'home' ? q.p25 : -q.p75;
      out.failure.push('Ordinary variance: in a quarter of EdgeDesk’s own outcomes ' + team + (p25 >= 0 ? ' wins by only ' + p25.toFixed(0) : ' loses by ' + Math.abs(p25).toFixed(0)) + ' or worse.');
    }
    (b.uncertainty_drivers || []).forEach(function (u) { if (/turnover/i.test(u)) out.failure.push('Turnovers: V2.1 flags these teams as turnover-dependent, the largest single source of spread variance it measures.'); });
    out.note = 'Measurable conditions implied by the model’s mechanics and distribution. Not a prediction: any of them can fail while the side still covers, and the reverse.';
    out.available = true;
    return out;
  };

  /* =================================================================
     TIMELINES — the projection over the week, the market over the week,
     and the gap between them. Point in time: nothing after b.now (or, for
     a settled game, after kickoff) is plotted.
     b.checkpoints = [{at, home_margin, checkpoint, model_version, source}]
     ================================================================= */
  function modelAt(series, t) {
    var cur = null;
    for (var i = 0; i < series.length; i++) { if (ms(series[i].at) <= t) cur = series[i]; else break; }
    return cur;
  }
  T.timelines = function (b, A, cfg) {
    var g = b.game || {}, now = ms(b.now), ko = ms(g.kickoff);
    var cut = ko != null && ko < now ? ko : now;
    var model = (b.checkpoints || []).filter(function (p) { return p && num(p.home_margin) != null && ms(p.at) != null && ms(p.at) <= cut; })
      .map(function (p) { return { at: iso(p.at), home_margin: r2(p.home_margin), checkpoint: p.checkpoint || null, model_version: p.model_version || null, source: p.source || null,
        day: new Date(ms(p.at)).toUTCString().slice(0, 3) }; })
      .sort(function (x, y) { return ms(x.at) - ms(y.at); });
    /* collapse consecutive identical numbers, keeping the first time */
    var mSeries = [];
    model.forEach(function (p) { var last = mSeries[mSeries.length - 1]; if (!last || Math.abs(last.home_margin - p.home_margin) >= 0.005 || last.model_version !== p.model_version) mSeries.push(p); });
    /* the market: the consensus of each book's latest line at each capture time */
    var qs = ((b.market && b.market.quotes) || []).filter(function (q) { return q && num(q.home_line) != null && ms(q.observed_at) != null && ms(q.observed_at) <= cut; })
      .sort(function (x, y) { return ms(x.observed_at) - ms(y.observed_at); });
    var latest = {}, mk = [];
    qs.forEach(function (q) {
      latest[String(q.book).toLowerCase()] = q.home_line;
      var ls = Object.keys(latest).map(function (k) { return latest[k]; });
      var c = median(ls);
      var last = mk[mk.length - 1];
      if (!last || Math.abs(last.home_line - c) >= 0.005 || last.books !== ls.length) mk.push({ at: iso(q.observed_at), home_line: r2(c), books: ls.length, day: new Date(ms(q.observed_at)).toUTCString().slice(0, 3) });
    });
    /* the gap at every change of either series */
    var times = mSeries.map(function (p) { return ms(p.at); }).concat(mk.map(function (p) { return ms(p.at); })).sort(function (x, y) { return x - y; });
    var gaps = [], events = [], opened = false, peakSide = null;
    times.forEach(function (t) {
      var m = modelAt(mSeries, t), k = modelAt(mk, t);
      if (!m || !k) return;
      var gap = m.home_margin - (-k.home_line), prev = gaps[gaps.length - 1];
      if (prev && prev.t === t) { prev.gap = r2(gap); return; }
      gaps.push({ t: t, at: iso(t), gap: r2(gap), model: m.home_margin, market_margin: r2(-k.home_line) });
      var side = gap > 0 ? 'home' : (gap < 0 ? 'away' : null);
      if (!opened && Math.abs(gap) >= cfg.research_gap) { opened = true; peakSide = side;
        events.push({ at: iso(t), kind: 'DISAGREEMENT_OPENED', text: 'Disagreement opened: ' + Math.abs(gap).toFixed(1) + ' pts toward ' + (side === 'home' ? g.home : g.away) + '.' }); }
      if (prev) {
        var dm = (-k.home_line) - prev.market_margin;           /* market margin change */
        var dmod = m.home_margin - prev.model;
        if (Math.abs(dm) >= cfg.move_pts && peakSide) {
          var toward = (peakSide === 'home' && dm > 0) || (peakSide === 'away' && dm < 0);
          events.push({ at: iso(t), kind: toward ? 'MARKET_TOWARD' : 'MARKET_AWAY', text: 'Market moved ' + Math.abs(dm).toFixed(1) + ' pts ' + (toward ? 'toward' : 'away from') + ' EdgeDesk.' });
        }
        if (Math.abs(dmod) >= cfg.move_pts) events.push({ at: iso(t), kind: 'MODEL_MOVED', text: 'EdgeDesk moved ' + Math.abs(dmod).toFixed(1) + ' pts toward ' + (dmod > 0 ? g.home : g.away) + '.' });
        if (opened && Math.abs(prev.gap) >= 1 && (Math.abs(gap) < 1 || (side && peakSide && side !== peakSide))) {
          events.push({ at: iso(t), kind: 'EDGE_GONE', text: side && side !== peakSide ? 'The disagreement reversed sides.' : 'The disagreement closed to under a point.' });
        }
      }
    });
    gaps.forEach(function (x) { delete x.t; });
    return { model: mSeries, market: mk, gaps: gaps, events: events,
      point_in_time: 'every point was captured at or before ' + iso(cut) + (cut === ko ? ' (kickoff)' : ' (this build)') + '; nothing later is plotted',
      model_note: 'EdgeDesk’s number moves only on football inputs. The market series is plotted beside it and never enters it.' };
  };

  /* =================================================================
     EDGE DECAY — initial vs current gap, and what closed it
     ================================================================= */
  T.edgeDecay = function (TL, C, cfg) {
    var out = { available: false };
    var gs = TL && TL.gaps || [];
    if (!gs.length || !C.available) { out.reason = 'no time when both EdgeDesk and the market were on file'; return out; }
    var first = gs[0], last = gs[gs.length - 1];
    var sideSign = first.gap > 0 ? 1 : (first.gap < 0 ? -1 : 0);
    if (!sideSign || Math.abs(first.gap) < cfg.research_gap) {
      out.available = true; out.verdict = 'NO_INITIAL_EDGE';
      out.text = 'EdgeDesk and the market were within ' + cfg.research_gap + ' pts when both were first on file (' + Math.abs(first.gap).toFixed(1) + ' pts): there was no initial edge to decay.';
      out.initial = { at: first.at, points: r2(Math.abs(first.gap)) }; out.current = { at: last.at, points: r2(sideSign * last.gap) };
      return out;
    }
    var init = sideSign * first.gap, cur = sideSign * last.gap;
    var marketMove = sideSign * (last.market_margin - first.market_margin);      /* + = market came toward EdgeDesk's side */
    var modelMove = sideSign * (last.model - first.model);                        /* + = EdgeDesk moved further to its side */
    var ratio = cur / init;
    var v = cur <= 0 ? 'REVERSED' : (ratio <= cfg.decay_most_gone ? 'MOST_GONE' : (ratio <= cfg.decay_partial ? 'PARTIAL' : (ratio <= cfg.decay_grew ? 'INTACT' : 'GREW')));
    out = { available: true, verdict: v, initial: { at: first.at, points: r2(init) }, current: { at: last.at, points: r2(cur) },
      lost_to_market: r2(Math.max(0, marketMove)), market_moved_away: r2(Math.max(0, -marketMove)), model_moved: r2(modelMove),
      retained_share: r2(clamp(ratio, -1, 3)) };
    out.verdict_text = { REVERSED: 'THE EDGE REVERSED — the disagreement is now on the other side.', MOST_GONE: 'MOST OF THE VALUE IS GONE.',
      PARTIAL: 'PART OF THE VALUE IS GONE.', INTACT: 'THE EDGE IS INTACT.', GREW: 'THE GAP HAS GROWN.' }[v];
    out.text = 'Initial ' + init.toFixed(1) + ' pts → now ' + cur.toFixed(1) + ' pts. '
      + (marketMove > 0.05 ? 'The market moved ' + marketMove.toFixed(1) + ' pts toward EdgeDesk. ' : (marketMove < -0.05 ? 'The market moved ' + (-marketMove).toFixed(1) + ' pts away from EdgeDesk. ' : 'The market has not moved. '))
      + (Math.abs(modelMove) > 0.05 ? 'EdgeDesk itself moved ' + Math.abs(modelMove).toFixed(1) + ' pts ' + (modelMove > 0 ? 'further out.' : 'back toward the market.') : 'EdgeDesk’s number has held.');
    return out;
  };

  /* =================================================================
     WHAT CHANGED — the projection's own movement, attributed only where
     the snapshots carry the terms. The market is reported beside it and
     is never part of the attribution.
     b.snapshots = [{at, home_margin, terms:{key:pts}, qb:{home,away},
                     model_version}] (football/cfb_terminal/history)
     ================================================================= */
  T.whatChanged = function (b, TL, cfg) {
    var g = b.game || {}, out = { available: false, rows: [], attribution: 'unavailable' };
    var snaps = (b.snapshots || []).filter(function (s) { return s && num(s.home_margin) != null && ms(s.at) != null && ms(s.at) <= ms(b.now); })
      .sort(function (x, y) { return ms(x.at) - ms(y.at); });
    var series = TL.model || [];
    var from = null, to = null;
    /* prefer the terminal's own snapshots (with terms): the earliest this week vs the latest */
    if (snaps.length >= 2) { from = snaps[0]; to = snaps[snaps.length - 1]; }
    else if (series.length >= 2) { from = { at: series[0].at, home_margin: series[0].home_margin, model_version: series[0].model_version };
      to = { at: series[series.length - 1].at, home_margin: series[series.length - 1].home_margin, model_version: series[series.length - 1].model_version }; }
    if (!from || !to) { out.reason = 'only one EdgeDesk number is on file for this game so far'; return out; }
    var d = to.home_margin - from.home_margin;
    out.available = true;
    out.from = { at: from.at, home_margin: r2(from.home_margin), text: marginLine(from.home_margin, g.home, g.away, 1), day: new Date(ms(from.at)).toUTCString().slice(0, 3) };
    out.to = { at: to.at, home_margin: r2(to.home_margin), text: marginLine(to.home_margin, g.home, g.away, 1), day: new Date(ms(to.at)).toUTCString().slice(0, 3) };
    out.change = r2(d);
    out.text = Math.abs(d) < 0.05 ? 'No change: ' + out.to.text + ' since ' + out.from.day + '.'
      : out.from.day + ' ' + out.from.text + ' → ' + out.to.day + ' ' + out.to.text + ': ' + Math.abs(d).toFixed(1) + ' pts toward ' + (d > 0 ? g.home : g.away) + '.';
    if (from.terms && to.terms) {
      var keys = {}, k;
      for (k in from.terms) keys[k] = 1;
      for (k in to.terms) keys[k] = 1;
      Object.keys(keys).forEach(function (key) {
        var a = num(from.terms[key]) || 0, c = num(to.terms[key]) || 0, dd = c - a;
        if (Math.abs(dd) < 0.05) return;
        out.rows.push({ key: key, label: T.TERM_TEXT[key] || key, delta: r2(dd), text: (T.TERM_TEXT[key] || key) + ': ' + signed(Math.abs(dd)) + ' toward ' + (dd > 0 ? g.home : g.away) });
      });
      out.rows.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
      out.attribution = 'exact';
      out.attribution_text = 'The engine’s additive terms, which sum to the projection: the change is exactly their sum. They say which inputs moved, not why the world changed.';
    } else {
      out.attribution_text = Math.abs(d) < 0.05 ? null : 'Term-by-term attribution is unavailable for these snapshots (they carry the number, not the terms). The terminal stores the terms from this build on.';
    }
    /* state changes EdgeDesk can name: the quarterbacks, the model version */
    if (from.qb && to.qb) ['home', 'away'].forEach(function (s) {
      var a = from.qb[s] || {}, c = to.qb[s] || {};
      if ((a.player || null) !== (c.player || null) || (a.status || null) !== (c.status || null))
        out.rows.push({ key: 'qb_state_' + s, label: 'Quarterback state', delta: null, text: (s === 'home' ? g.home : g.away) + ' QB: ' + (a.player || '—') + ' (' + (a.status || '—') + ') → ' + (c.player || '—') + ' (' + (c.status || '—') + ')' });
    });
    if (from.model_version && to.model_version && from.model_version !== to.model_version)
      out.rows.push({ key: 'model_version', label: 'Model version', delta: null, text: 'Model version changed: ' + from.model_version + ' → ' + to.model_version });
    var mk = TL.market || [];
    if (mk.length >= 2) {
      var dm = (-mk[mk.length - 1].home_line) - (-mk[0].home_line);
      out.market = { change: r2(dm), text: Math.abs(dm) < 0.05 ? 'The market has not moved over the same window.' : 'Separately, the market moved ' + Math.abs(dm).toFixed(1) + ' pts toward ' + (dm > 0 ? g.home : g.away) + '. Market movement never changes EdgeDesk’s number.' };
    }
    return out;
  };

  /* =================================================================
     IS THE MARKET TELLING US SOMETHING?
     When the market moves away from EdgeDesk (or a gap is major), inspect
     every football and data source EdgeDesk holds. Never moves a number.
     ================================================================= */
  T.marketCheck = function (b, A, B, C, cfg) {
    var g = b.game || {}, out = { triggered: false, checks: [], verdict: 'NOT_TRIGGERED', verdict_text: null };
    var away = C.available && C.market_direction === 'AWAY';
    if (!C.available || (!away && C.class !== 'MAJOR')) { out.verdict_text = 'The market has not moved away from EdgeDesk and the gap is not major: no check needed.'; return out; }
    out.triggered = true;
    out.trigger = away ? C.market_direction_text : 'The gap is ' + C.points.toFixed(1) + ' pts (major).';
    var found = [];
    function chk(area, status, text) { out.checks.push({ area: area, status: status, text: text }); if (status === 'EXPLANATION') found.push(area); }
    ['home', 'away'].forEach(function (s) {
      var q = b.qb && b.qb[s], team = s === 'home' ? g.home : g.away;
      if (!q) chk('QB', 'EXPLANATION', team + ': no starter identified — a quarterback change the market knows about would explain a move.');
      else if (q.contested) chk('QB', 'EXPLANATION', team + ': contested quarterback job (' + (q.label || q.status) + ').');
      else if (!q.confirmed) chk('QB', 'OPEN', team + ': ' + (q.player || 'the starter') + ' expected, not confirmed.');
      else chk('QB', 'CLEAR', team + ': ' + q.player + ' confirmed.');
    });
    var av = b.availability || {};
    ['home', 'away'].forEach(function (s) {
      var a = av[s], team = s === 'home' ? g.home : g.away;
      if (!a || !a.state) chk('Injury', 'OPEN', team + ': no availability read on file.');
      else if (a.state === 'USABLE' || a.state === 'KNOWN') chk('Injury', 'CLEAR', team + ': availability read on file.');
      else chk('Injury', 'OPEN', team + ': availability ' + String(a.state).toLowerCase().replace(/_/g, ' ') + '.');
    });
    var gates = ((b.reliability && b.reliability.gates) || []).filter(function (x) { return x.binding; });
    if (gates.some(function (x) { return /ROSTER|CONFLICT/i.test(x.id || ''); })) chk('Roster', 'EXPLANATION', 'A roster/depth-chart conflict caps reliability: ' + gates.filter(function (x) { return /ROSTER|CONFLICT/i.test(x.id || ''); })[0].reason);
    else chk('Roster', 'CLEAR', 'No binding roster conflict.');
    if (b.weather && b.weather.available) chk('Weather', num(b.weather.wind_mph) != null && b.weather.wind_mph >= 20 ? 'EXPLANATION' : 'CLEAR', 'Forecast on file' + (num(b.weather.wind_mph) != null ? ': wind ' + b.weather.wind_mph + ' mph' : '') + '.');
    else chk('Weather', 'OPEN', 'No forecast on file for kickoff.');
    var integ = C.integrity;
    /* the GAME group of the integrity gate is the mapping check (teams,
       orientation, identity join, kickoff, venue) — judged by group, never by
       the words in a detail */
    var mapFail = integ && (integ.failed_checks || []).filter(function (c) { return c.group === 'GAME'; });
    if (mapFail && mapFail.length) chk('Mapping', 'EXPLANATION', 'Integrity check failed: ' + mapFail[0].detail + '.');
    else chk('Mapping', 'CLEAR', 'Teams and orientation resolved.');
    if (B.stale) chk('Market quality', 'EXPLANATION', 'The only quotes are stale.');
    else if (B.books_fresh < cfg.min_books) chk('Market quality', 'OPEN', 'Only ' + B.books_fresh + ' fresh book' + (B.books_fresh === 1 ? '' : 's') + ' (a consensus needs ' + cfg.min_books + ').');
    else if (num(B.dispersion) != null && B.dispersion > cfg.max_dispersion_iqr) chk('Market quality', 'EXPLANATION', 'Books disagree by ' + B.dispersion.toFixed(1) + ' pts.');
    else chk('Market quality', 'CLEAR', B.books_fresh + ' fresh books within ' + (B.dispersion || 0).toFixed(1) + ' pts.');
    var open = out.checks.filter(function (c) { return c.status === 'OPEN'; }).map(function (c) { return c.area; });
    open = open.filter(function (x, i) { return open.indexOf(x) === i; });
    out.verdict = found.length ? 'POSSIBLE_EXPLANATION' : (open.length ? 'UNRESOLVED' : 'NO_NEW_INFORMATION');
    out.verdict_text = found.length ? 'POSSIBLE EXPLANATION FOUND: ' + found.filter(function (x, i) { return found.indexOf(x) === i; }).join(', ') + '. EdgeDesk’s projection is unchanged; this is where to look.'
      : (open.length ? 'NO NEW FOOTBALL INFORMATION FOUND — but ' + open.join(', ') + ' ' + (open.length === 1 ? 'is' : 'are') + ' unresolved, and the market may already be pricing ' + (open.length === 1 ? 'it' : 'them') + '. The projection is unchanged.'
        : 'NO NEW FOOTBALL INFORMATION FOUND in anything EdgeDesk holds. The market may know something EdgeDesk does not — or it may be wrong. The projection is unchanged.');
    return out;
  };

  /* MARKET CONTRADICTION PANEL — for a major gap */
  T.contradiction = function (b, A, B, C, K, X, cfg) {
    if (!C.available || C.class !== 'MAJOR') return { available: false };
    var ev = [], mk = [], un = [];
    if (K && K.available) {
      var near = K.rows.filter(function (r) { return r.independent && Math.abs(r.home_margin - A.home_margin) <= 2; });
      ev.push(near.length + ' of ' + K.n_independent + ' independent models within 2 pts of EdgeDesk (' + near.map(function (r) { return r.label + ' ' + r.text; }).join('; ') + ').');
    }
    ev.push('EdgeDesk fair ' + A.fair_text + ' · football confidence ' + (A.football_confidence.score == null ? '—' : A.football_confidence.score) + '.');
    if (B.move_since_open) mk.push('Open ' + bookTextExact(-B.open_home_line) + ' → now ' + bookTextExact(-B.consensus_home_line) + ' (' + (b.game || {}).home + '), ' + B.move_since_open.text + '.');
    mk.push(B.books_fresh + ' fresh book' + (B.books_fresh === 1 ? '' : 's') + ', consensus ' + (B.consensus_text || '—') + '.');
    (X && X.checks || []).filter(function (c) { return c.status !== 'CLEAR'; }).forEach(function (c) { un.push(c.area + ': ' + c.text); });
    var status = C.verification === 'VERIFIED' ? (un.length ? 'RECHECK' : 'HOLDS') : (C.verification === 'DATA_FAULT' ? 'DATA FAULT' : 'INVESTIGATE');
    return { available: true, edgedesk: ev, market: mk, unresolved: un, status: status,
      status_text: { RECHECK: 'RECHECK — verified, but open information could still explain the market.', HOLDS: 'HOLDS — verified, and nothing EdgeDesk holds explains the market.',
        'DATA FAULT': 'DATA FAULT — an integrity check found a data problem.', INVESTIGATE: 'INVESTIGATE — not verified.' }[status] };
  };

  /* =================================================================
     THE STATUS — first rule that holds. Fail closed.
     b.decision = the decision engine's verdict for the canonical model at
     the best current quote: {status, reason_codes, reasons, detail}
     ================================================================= */
  T.status = function (b, A, B, C, F, K, R, cfg) {
    var g = b.game || {}, blockers = [], key, reason;
    var d = b.decision || { status: 'NO_BET', reason_codes: ['NO_BET_COMPUTATION'], reasons: ['no decision was computed'] };
    var conf = A.available ? A.football_confidence.score : null, rel = b.reliability ? num(b.reliability.score) : null;
    function block(code, text) { blockers.push({ code: code, text: text }); }
    /* the standing blockers every non-BET carries */
    (d.reasons || []).forEach(function (t, i) { block((d.reason_codes || [])[i] || 'DECISION', 'Decision engine: ' + t + (d.detail && i === 0 ? ' (' + d.detail + ')' : '') + '.'); });
    if (b.trust && b.trust.betting_enabled === false) block('BETTING_DISABLED', 'Betting is disabled by the frozen decision policy until it passes its promotion gate.');
    if (b.trust && b.trust.calibrated_ev_note) block('CALIBRATED_EV', b.trust.calibrated_ev_note);

    if (b.fault) { key = 'DATA_FAULT'; reason = b.fault; }
    else if (!A.available) { key = B.available ? 'PASS' : 'NO_MARKET'; reason = A.reason + '.'; }
    else if (C.available && C.verification === 'DATA_FAULT') { key = 'DATA_FAULT'; reason = 'The integrity gate found a data problem: ' + (C.integrity.failed[0] || 'see the checks') + '.'; }
    else if (C.available && C.points > cfg.guard_gap && !C.verified) { key = 'DATA_FAULT'; reason = 'A ' + C.points.toFixed(1) + '-point gap is past the ' + cfg.guard_gap + '-point guard bound and unverified.'; }
    else if (!B.available) { key = 'NO_MARKET'; reason = B.reason + '.'; }
    else if (B.stale) { key = 'NO_MARKET'; reason = 'The only quotes on file are older than ' + cfg.stale_minutes + ' minutes (' + B.age_minutes + ' min): not a price.'; }
    else if (C.available && C.verification === 'MARKET_FAULT') { key = 'INVESTIGATE'; reason = 'A ' + C.points.toFixed(1) + '-point gap the market cannot verify: '
      + ((C.integrity && C.integrity.failed.filter(function (t) { return /book|captured|stale|dispersion|spread of|quote/i.test(t); })[0]) || (B.books_fresh + ' fresh book' + (B.books_fresh === 1 ? '' : 's') + ' — the integrity gate needs a multi-book market')) + '.'; }
    else if (C.available && C.class === 'MAJOR' && !C.verified) { key = 'INVESTIGATE'; reason = 'A ' + C.points.toFixed(1) + '-point gap that has not passed the integrity checks (' + String(C.verification).toLowerCase().replace(/_/g, ' ') + ').'; }
    else if (d.status === 'BET' && F.current) { key = 'BET'; reason = 'The decision engine certified ' + F.current.text + '.'; }
    else if (conf == null || conf < cfg.min_confidence) { key = 'PASS'; reason = 'Football confidence ' + (conf == null ? 'unmeasured' : conf) + ' is under the ' + cfg.min_confidence + ' floor: EdgeDesk will not lean.'; }
    else if (rel != null && rel < cfg.low_reliability) { key = 'PASS'; reason = 'Reliability ' + rel + ' is under ' + cfg.low_reliability + ': a gap on unreliable inputs is more suspicious, not less.'; }
    else if (!C.available || C.class === 'ALIGNED') { key = 'PASS'; reason = 'EdgeDesk and the market are ' + (C.available ? C.points.toFixed(1) + ' pts' : '—') + ' apart, inside the ' + cfg.research_gap + '-point research threshold.'; }
    else if (K && K.available && K.sd != null && K.sd > cfg.max_model_sd) { key = 'PASS'; reason = 'EdgeDesk’s own models disagree by SD ' + K.sd.toFixed(1) + ', past the policy’s ' + cfg.max_model_sd + '-point limit.'; }
    else if (!F.available || !F.current) {
      /* a research-sized gap whose only fresh quotes carry no odds (an
         odds-free consensus line): nothing can be priced yet, so WAIT for a
         priced quote rather than pretending there is nothing to research */
      if (F.available && B.books_fresh > 0) { key = 'WAIT'; reason = 'A ' + C.points.toFixed(1) + '-point disagreement toward ' + C.toward_team + ', but the fresh quotes carry no odds (a consensus line only): wait for a priced quote before evaluating it.'; }
      else { key = 'PASS'; reason = 'No priced quote on EdgeDesk’s side (' + (F.reason || 'no price') + ').'; }
    }
    else if (F.current.edge == null || F.current.edge <= 0) { key = 'PASS'; reason = 'At ' + F.current.text + ' the model’s cover probability (' + pct(F.current.cover, 1) + ') does not clear break-even (' + pct(F.current.break_even, 1) + ').'; }
    else {
      var qbWait = ['home', 'away'].filter(function (s) { return b.qb && b.qb[s] && b.qb[s].contested; });
      var reach = F.preferred_entry && F.current && (F.preferred_entry.line - F.current.line) > 0 && (F.preferred_entry.line - F.current.line) <= cfg.typical_move_pts;
      if (qbWait.length) { key = 'WAIT'; reason = 'Wait for the quarterback decision: ' + qbWait.map(function (s) { return s === 'home' ? g.home : g.away; }).join(' and ') + ' ' + (qbWait.length > 1 ? 'have' : 'has') + ' a contested job, and the thesis depends on who starts.'; }
      else if (F.current.edge < cfg.min_probability_edge && reach) { key = 'WAIT'; reason = 'At ' + F.current.text + ' the edge (' + pp(F.current.edge) + ') is under the ' + pp(cfg.min_probability_edge, 0) + ' minimum. It reaches ' + pp(cfg.ideal_probability_edge, 0) + ' at ' + F.preferred_entry.text + ' — inside ordinary open-to-close movement (' + cfg.typical_move_pts + ' pts).'; }
      else if (F.current.edge < cfg.min_probability_edge) { key = 'PASS'; reason = 'At ' + F.current.text + ' the model’s cover probability is ' + pct(F.current.cover, 1) + ' against ' + pct(F.current.break_even, 1) + ' break-even: no margin for model error.'; }
      else { key = 'RESEARCH'; reason = 'A ' + C.points.toFixed(1) + '-point disagreement toward ' + C.toward_team + ' at a live price (' + F.current.text + ', ' + pp(F.current.edge) + ' model edge) with usable confidence and reliability.'; }
    }
    /* game-specific reasons the research is not a bet (WHY NOT BET THIS?) */
    if (key !== 'BET') {
      if (C.available && C.points >= cfg.research_gap) {
        ['home', 'away'].forEach(function (s) { var q = b.qb && b.qb[s]; if (q && (q.contested || !q.confirmed)) block('QB_' + s.toUpperCase(), (s === 'home' ? g.home : g.away) + ' quarterback ' + (q.contested ? 'contested' : 'not confirmed') + '.'); });
        if (K && K.available && K.agreement && K.agreement.tier !== 'HIGH') block('MODEL_DISAGREEMENT', 'Model agreement ' + K.agreement.tier + ' (SD ' + K.sd.toFixed(1) + ' pts).');
        if (B.available && B.books_fresh < cfg.min_books) block('THIN_MARKET', 'Only ' + B.books_fresh + ' fresh book' + (B.books_fresh === 1 ? '' : 's') + ' (a bet needs ' + cfg.min_books + ').');
        if (F.available && F.current) {
          block('MARGIN_FOR_ERROR', 'Cover probability ' + pct(F.current.cover, 1) + ' vs break-even ' + pct(F.current.break_even, 1) + ' (' + pp(F.current.edge) + '): EdgeDesk’s typical miss is ' + (num(b.expected_abs_error) != null ? b.expected_abs_error.toFixed(1) + ' pts' : 'unmeasured') + '.');
        }
        if (C.class === 'MAJOR' && !C.verified) block('UNVERIFIED', 'The major gap is not verified.');
      }
      if (B.available && B.stale) block('STALE_MARKET', 'The market quote is stale.');
    }
    var S = T.STATUS[key];
    return { key: key, label: S.label, tone: S.tone, rank: S.rank, means: S.means, reason: reason,
      price_condition: F && F.available ? { current: F.current ? F.current.text : null, preferred: F.preferred_entry ? F.preferred_entry.text : null,
        bettable_to: F.bettable_to ? F.bettable_to.text : null, pass_beyond: F.pass_beyond ? F.pass_beyond.text : null } : null,
      why_not_bet: key === 'BET' ? [] : blockers,
      decision: { status: d.status, reason_codes: (d.reason_codes || []).slice(), engine: d.engine || 'edgedesk_cfb_decision', model_version: d.model_version || null },
      verified_badge: !!(C.available && C.verified) };
  };

  /* =================================================================
     FOUR SEPARATE FIELDS — a fascinating game is not a good wager
     ================================================================= */
  T.fields = function (A, B, C, F, K, S, b, cfg) {
    var conf = A.available ? A.football_confidence.score : null, rel = b.reliability ? num(b.reliability.score) : null;
    var fd = C.available ? { points: C.points, toward: C.toward_team, class: C.class, verified: C.verified, verification: C.verification } : null;
    var pv = F.available && F.current ? { edge: F.current.edge, ev: F.current.ev, cover: F.current.cover, break_even: F.current.break_even, at: F.current.text, grade: F.current.grade,
      trusted: S.key !== 'INVESTIGATE' && S.key !== 'DATA_FAULT' && S.key !== 'NO_MARKET', validated: S.key === 'BET' } : null;
    /* RESEARCH INTEREST, 0-100: how worth opening, never how good a bet.
       D disagreement (capped at the major threshold; a verified major gap
       counts in full, an unverified one half), P the price edge, Q the
       information quality, A model agreement, M movement / new information.
       Garbage gaps are held down twice: Q, and the gate on D. */
    var D = 0, P = 0, Q = 0, AG = 0, MV = 0;
    if (fd) {
      D = Math.min(fd.points, cfg.major_gap) / cfg.major_gap;
      if (fd.class === 'MAJOR') D = fd.verified ? 1 : 0.5;
      if (fd.class === 'ALIGNED') D *= 0.5;
    }
    if (pv && num(pv.edge) != null) P = clamp(pv.edge / cfg.grade_strong_edge, 0, 1);
    /* a price edge measured off an unverified major gap is not trusted in full */
    if (fd && fd.class === 'MAJOR' && !fd.verified) P *= 0.5;
    Q = ((conf == null ? 0 : clamp(conf / 100, 0, 1)) + (rel == null ? 0 : clamp(rel / 100, 0, 1))) / 2;
    if (K && K.available && K.agreement && num(K.agreement.score) != null) AG = K.agreement.score / 100;
    if (C.available && C.market_direction === 'TOWARD') MV = 0.6;
    if (C.available && C.market_direction === 'AWAY') MV = 1;          /* the market saying something is worth reading */
    var score = Math.round(100 * (0.35 * D + 0.2 * P + 0.2 * Q + 0.15 * AG + 0.1 * MV));
    if (S.key === 'DATA_FAULT' || S.key === 'NO_MARKET') score = Math.min(score, 10);
    if (rel != null && rel < cfg.low_reliability) score = Math.min(score, 25);
    var ri = { score: score, components: { disagreement: r2(D), price: r2(P), quality: r2(Q), agreement: r2(AG), movement: r2(MV) },
      basis: '100 × (0.35 disagreement + 0.20 price + 0.20 information quality + 0.15 model agreement + 0.10 movement); capped at 10 for DATA FAULT / NO MARKET and at 25 under reliability ' + cfg.low_reliability };
    var bq = { certified: S.key === 'BET', grade: S.key === 'BET' ? 'CERTIFIED' : 'NOT CERTIFIED',
      text: S.key === 'BET' ? 'The decision engine certified this price.' : 'Not a certified bet: ' + (S.why_not_bet[0] ? S.why_not_bet[0].text : S.reason) };
    return { football_disagreement: fd, price_value: pv, research_interest: ri, bet_quality: bq };
  };

  /* =================================================================
     FILTERS — each a yes/no on the finished object
     ================================================================= */
  T.FILTERS = {
    verified: { label: 'Verified disagreements', test: function (o) { return !!(o.disagreement.verified); } },
    aligned: { label: 'Model aligned', test: function (o) { return o.consensus.available && o.consensus.agreement && o.consensus.agreement.tier === 'HIGH'; } },
    high_confidence: { label: 'High confidence', test: function (o) { return o.edgedesk.available && o.edgedesk.football_confidence.tier === 'HIGH'; } },
    qb_confirmed: { label: 'QB confirmed', test: function (o) { return !!(o.qb && o.qb.home && o.qb.home.confirmed && o.qb.away && o.qb.away.confirmed); } },
    low_model_disagreement: { label: 'Low model disagreement', test: function (o) { return o.consensus.available && o.consensus.sd != null && o.consensus.sd < 3; } },
    best_prices: { label: 'Best prices', test: function (o) { return !!(o.price.available && o.price.current && o.price.current.edge != null && o.price.current.edge >= 0.02); } },
    moving_toward: { label: 'Market moving toward EdgeDesk', test: function (o) { return o.disagreement.market_direction === 'TOWARD'; } },
    moving_away: { label: 'Market moving away', test: function (o) { return o.disagreement.market_direction === 'AWAY'; } },
    near_pickem: { label: 'Near pick’em', test: function (o) { return o.edgedesk.available && Math.abs(o.edgedesk.home_margin) < 3; } },
    thin_data: { label: 'FCS / thin data', test: function (o) { return !!(o.game.fcs || (o.games_played && num(o.games_played.min) != null && o.games_played.min < 3) || (o.data_quality.reliability != null && o.data_quality.reliability < 60)); } },
    cleanest: { label: 'Cleanest research', test: function (o) { return T.isCleanest(o); } },
    uncertain: { label: 'Most uncertain', test: function (o) { return T.uncertainty(o).score >= 50; } }
  };
  /* CLEANEST RESEARCH: meaningful but not necessarily huge */
  T.isCleanest = function (o, cfg) {
    cfg = cfg || T.CONFIG;
    var rel = o.data_quality.reliability;
    return !!(o.edgedesk.available && o.edgedesk.football_confidence.score != null && o.edgedesk.football_confidence.score >= cfg.high_confidence
      && rel != null && rel >= cfg.strong_reliability
      && o.consensus.available && o.consensus.sd != null && o.consensus.sd < cfg.agree_moderate_sd
      && o.market.available && !o.market.stale
      && o.disagreement.available && o.disagreement.points >= cfg.research_gap && o.disagreement.class !== 'MAJOR'
      && o.status.key !== 'DATA_FAULT' && o.status.key !== 'NO_MARKET');
  };
  /* MOST UNCERTAIN: a 0-100 uncertainty read, so false precision is visible */
  T.uncertainty = function (o) {
    var s = 0, why = [];
    ['home', 'away'].forEach(function (k) { var q = o.qb && o.qb[k]; if (!q || q.contested) { s += 20; why.push((k === 'home' ? o.game.home : o.game.away) + ' QB ' + (q ? 'contested' : 'unknown')); } });
    if (o.consensus.available && o.consensus.sd != null && o.consensus.sd >= 3) { s += 20; why.push('models disagree (SD ' + o.consensus.sd.toFixed(1) + ')'); }
    if (o.edgedesk.available && o.edgedesk.interval_80 && (o.edgedesk.interval_80.hi - o.edgedesk.interval_80.lo) >= 42) { s += 15; why.push('wide outcome range'); }
    if (o.games_played && num(o.games_played.min) != null && o.games_played.min < 3) { s += 15; why.push('thin current-season data'); }
    if (o.game.fcs) { s += 20; why.push('FCS opponent'); }
    if (o.data_quality.reliability != null && o.data_quality.reliability < 60) { s += 10; why.push('low reliability'); }
    return { score: Math.min(100, s), why: why };
  };

  /* =================================================================
     MODEL SAYS / MARKET SAYS — the 15-second summary
     ================================================================= */
  T.summary = function (o) {
    var g = o.game, A = o.edgedesk, C = o.disagreement, F = o.price, S = o.status;
    var why = null;
    if (!C.available) why = 'No market to compare with.';
    else if (C.class === 'ALIGNED') why = 'EdgeDesk and the market roughly agree (' + C.points.toFixed(1) + ' pts apart).';
    else if (o.why.market_implied && Math.abs(o.why.market_implied.difference) >= 1) why = o.why.market_implied.text;
    if (!why && o.why.available && o.why.rows.length && C.available && C.toward) {
      var top = o.why.rows.filter(function (r) { return r.favors === C.toward_team && Math.abs(r.points) >= 0.5; })
        .sort(function (x, y) { return Math.abs(y.points) - Math.abs(x.points); })[0];
      if (top) why = 'EdgeDesk’s largest term toward ' + C.toward_team + ' is ' + top.label.toLowerCase() + ' (' + Math.abs(top.points).toFixed(1) + ' pts).';
    }
    if (!why && o.matchup.available && C.available && C.toward) {
      var card = o.matchup.cards.filter(function (c) { return c.favors_side === C.toward && c.magnitude !== 'even' && c.magnitude !== 'small'; })[0];
      if (card) why = 'EdgeDesk’s unit data favours ' + C.toward_team + ' in the ' + card.label.toLowerCase() + ' (' + card.magnitude + ', ' + Math.abs(card.net_sd).toFixed(2) + ' SD).';
    }
    if (!why && o.why.v2_drivers && o.why.v2_drivers.rows.length && C.available && C.toward) {
      var dr = o.why.v2_drivers.rows.filter(function (r) { return r.favors === C.toward_team; })[0];
      if (dr) why = 'The production pathway’s largest driver toward ' + C.toward_team + ' is ' + dr.label.toLowerCase() + ' (' + Math.abs(dr.points).toFixed(1) + ' pts).';
    }
    var risk = o.risks.items.length ? o.risks.items[0].text : 'No high-severity risk on file.';
    return {
      model_says: A.available ? A.fair_text : 'No EdgeDesk number',
      market_says: o.market.available && o.market.consensus_text ? o.market.consensus_text + (o.market.stale ? ' (stale)' : '') : 'No market',
      gap: C.available ? C.text : null,
      why: why || (C.available && C.class === 'ALIGNED' ? 'EdgeDesk and the market roughly agree.' : 'No single measured term explains the gap.'),
      risk: risk,
      price: S.key === 'INVESTIGATE' ? 'Not priced until verified: at this size, missing information is more often the cause than an edge.'
        : (S.key === 'DATA_FAULT' ? 'Not priced: EdgeDesk’s number is unsafe until the data fault is explained.'
        : (S.key === 'NO_MARKET' ? 'No live price.'
        : (F.available && F.current ? pp(F.current.edge) + ' model edge at ' + F.current.text + ' (model EV ' + (F.current.ev >= 0 ? '+' : '') + (100 * F.current.ev).toFixed(1) + '%, research — not validated)' : (F.reason || 'No price')))),
      status: S.label, status_reason: S.reason
    };
  };

  /* BEST QUESTIONS TO ASK — chosen by what the object actually carries */
  T.questions = function (o) {
    var q = [];
    if (o.disagreement.available && o.disagreement.points >= 2) q.push('Why does EdgeDesk disagree with the market?');
    if (o.reconcile.available) q.push('What would have to be wrong for the market to be right?');
    q.push('What could make this a pass?');
    if (o.timeline.market.length >= 2 || o.market.move_since_open) q.push('Has the market moved?');
    if (o.what_changed.available) q.push('What changed since the first number?');
    q.push('Which player matters most?');
    if (o.sensitivity.available) q.push('How sensitive is the projection?');
    if (o.price.available) q.push('Is this price still good?');
    q.push('How has EdgeDesk done in similar games?');
    return q.slice(0, 8);
  };

  /* =================================================================
     THE BUILD — one object per game
     ================================================================= */
  T.build = function (b, over) {
    b = b || {};
    var cfg = T.config(over || b.config);
    var g = b.game || {};
    var A = T.edgedeskView(b, cfg);
    var B = T.marketView(b, cfg);
    var C = T.disagreementView(b, A, B, cfg);
    b.market_margin = C.available ? C.market_margin : null;
    var WHY = T.decomposition(b, A);
    var F = T.priceView(b, A, B, C, cfg);
    var K = T.consensus(b, A, C, cfg);
    var R = T.reconcile(b, A, C, K, cfg);
    var SENS = T.sensitivity(b, A, cfg);
    var M = T.matchupCards(b);
    var TL = T.timelines(b, A, cfg);
    var DEC = T.edgeDecay(TL, C, cfg);
    var WC = T.whatChanged(b, TL, cfg);
    var X = T.marketCheck(b, A, B, C, cfg);
    var S = T.status(b, A, B, C, F, K, R, cfg);
    var o = {
      schema: T.schema, contract: T.version, built_at: iso(b.now),
      game_id: String(g.game_id), season: g.season || null, week: g.week || null, kickoff: g.kickoff || null,
      game: { home: g.home, away: g.away, neutral_site: !!g.neutral_site, venue: g.venue || null,
        home_conference: g.home_conference || null, away_conference: g.away_conference || null,
        matchup_type: g.matchup_type || null, fcs: !!g.fcs, cross_conference: !!g.cross_conference },
      edgedesk: A, market: B, disagreement: C, why: WHY,
      risks: T.risks(b, A, C, K, cfg), reconcile: R, sensitivity: SENS,
      price: F, cover_curve: F.available && F.current ? T.coverCurve(b, F.side, F.current.line, cfg) : [],
      key_numbers: T.keyNumbers(b, B, F, cfg), line_shopping: T.lineShopping(b, A, B, C, F, cfg),
      timing: T.timing(b, S, cfg),
      timeline: TL, edge_decay: DEC, what_changed: WC, consensus: K, matchup: M,
      paths: T.paths(b, A, F, M, R, cfg), market_check: X,
      contradiction: T.contradiction(b, A, B, C, K, X, cfg),
      historical: b.historical || { available: false, reason: 'no historical context supplied' },
      data_quality: T.dataQuality(b, B), trust: T.trust(b, B),
      qb: b.qb || null, games_played: b.games_played || null,
      status: S
    };
    o.fields = T.fields(A, B, C, F, K, S, b, cfg);
    o.summary = T.summary(o);
    o.questions = T.questions(o);
    o.uncertainty = T.uncertainty(o);
    o.flags = {};
    Object.keys(T.FILTERS).forEach(function (k) { try { o.flags[k] = !!T.FILTERS[k].test(o); } catch (e) { o.flags[k] = false; } });
    o.sources = (b.sources || []).slice();
    return deepFreeze(o);
  };

  /* MARKET TIMING: bet now vs wait, only on validated evidence */
  T.timing = function (b, S, cfg) {
    var w = b.wait_policy || null;
    var out = { verdict: 'NONE', validated: false, expected_clv: null };
    if (w && w.enabled) { out.validated = true; out.text = 'The decision policy has validated timing evidence.'; }
    else out.text = 'No validated evidence that waiting pays: the decision policy’s WAIT rule is disabled (' + (w && w.note ? w.note : 'no evidence') + '). EdgeDesk does not forecast line movement.';
    out.movement_context = 'For scale: a college line moves about ' + cfg.typical_move_pts + ' pts from open to close on average (football/validation/movement_cfb.json, held-out MAE of no-move).';
    if (S.key === 'WAIT') out.verdict = 'WAIT';
    else if (S.key === 'BET') out.verdict = 'BET_NOW';
    return out;
  };

  /* =================================================================
     THE SLATE — queue, counts, lanes
     ================================================================= */
  T.queue = function (objs) {
    return (objs || []).slice().sort(function (a, c) {
      /* verified majors first, then research interest; ties by kickoff */
      var va = a.disagreement.verified ? 1 : 0, vc = c.disagreement.verified ? 1 : 0;
      if (va !== vc) return vc - va;
      var d = c.fields.research_interest.score - a.fields.research_interest.score;
      if (d) return d;
      return (ms(a.kickoff) || 0) - (ms(c.kickoff) || 0);
    });
  };
  T.counts = function (objs) {
    var c = {};
    T.STATUS_KEYS.forEach(function (k) { c[k] = 0; });
    (objs || []).forEach(function (o) { c[o.status.key] = (c[o.status.key] || 0) + 1; });
    c.verified = (objs || []).filter(function (o) { return o.disagreement.verified; }).length;
    c.total = (objs || []).length;
    return c;
  };
  T.filter = function (objs, keys) {
    keys = (keys || []).filter(function (k) { return T.FILTERS[k]; });
    if (!keys.length) return (objs || []).slice();
    return (objs || []).filter(function (o) { return keys.every(function (k) { return o.flags ? o.flags[k] : T.FILTERS[k].test(o); }); });
  };

  /* =================================================================
     WEEKLY RESEARCH BRIEF — structured, never forced picks
     ================================================================= */
  T.brief = function (objs, meta) {
    var list = objs || [];
    function row(o, extra) { return { game_id: o.game_id, matchup: o.game.away + ' @ ' + o.game.home, kickoff: o.kickoff, status: o.status.label,
      model_says: o.summary.model_says, market_says: o.summary.market_says, gap: o.summary.gap, note: extra || null }; }
    var verified = list.filter(function (o) { return o.disagreement.verified; }).sort(function (a, c) { return c.disagreement.points - a.disagreement.points; });
    var clean = list.filter(function (o) { return o.flags.cleanest; }).sort(function (a, c) { return c.fields.research_interest.score - a.fields.research_interest.score; });
    var unc = list.slice().sort(function (a, c) { return c.uncertainty.score - a.uncertainty.score; }).filter(function (o) { return o.uncertainty.score >= 50; });
    var changes = list.filter(function (o) { return o.what_changed.available && Math.abs(o.what_changed.change) >= 0.75; }).sort(function (a, c) { return Math.abs(c.what_changed.change) - Math.abs(a.what_changed.change); });
    var toward = list.filter(function (o) { return o.disagreement.market_direction === 'TOWARD'; });
    var gone = list.filter(function (o) { return o.edge_decay.available && (o.edge_decay.verdict === 'MOST_GONE' || o.edge_decay.verdict === 'REVERSED'); });
    var qb = list.filter(function (o) { return o.qb && ((o.qb.home && o.qb.home.contested) || (o.qb.away && o.qb.away.contested)); });
    var bets = list.filter(function (o) { return o.status.key === 'BET'; });
    return {
      schema: 'edgedesk_cfb_research_brief_v1', generated_at: meta && meta.generated_at || null, season: meta && meta.season || null, week: meta && meta.week || null,
      headline: bets.length ? bets.length + ' certified bet' + (bets.length === 1 ? '' : 's') + ' this week.'
        : 'No certified bets this week. That is a normal answer: the research below is the product.',
      counts: T.counts(list),
      sections: [
        { key: 'verified', title: 'Largest verified disagreements', rows: verified.slice(0, 5).map(function (o) { return row(o, o.disagreement.text); }), empty: 'No gap passed every integrity check this week.' },
        { key: 'cleanest', title: 'Cleanest research setups', rows: clean.slice(0, 5).map(function (o) { return row(o, 'confidence ' + o.edgedesk.football_confidence.score + ', reliability ' + o.data_quality.reliability + ', model SD ' + o.consensus.sd); }), empty: 'No game meets every cleanest-research condition.' },
        { key: 'uncertain', title: 'Most uncertain games', rows: unc.slice(0, 5).map(function (o) { return row(o, o.uncertainty.why.join('; ')); }), empty: 'No game is unusually uncertain.' },
        { key: 'changes', title: 'Biggest projection changes', rows: changes.slice(0, 5).map(function (o) { return row(o, o.what_changed.text); }), empty: 'No EdgeDesk number moved 0.75 pts or more.' },
        { key: 'toward', title: 'Market moving toward EdgeDesk', rows: toward.slice(0, 5).map(function (o) { return row(o, o.disagreement.market_direction_text); }), empty: 'No market has moved half a point toward EdgeDesk since its open.' },
        { key: 'gone', title: 'Prices already gone', rows: gone.slice(0, 5).map(function (o) { return row(o, o.edge_decay.text); }), empty: 'No disagreement has decayed away yet.' },
        { key: 'qb', title: 'Quarterback situations to monitor', rows: qb.slice(0, 8).map(function (o) {
          var t = []; ['home', 'away'].forEach(function (s) { var q = o.qb[s]; if (q && q.contested) t.push((s === 'home' ? o.game.home : o.game.away) + ': ' + (q.label || q.status)); });
          return row(o, t.join(' · ')); }), empty: 'No contested quarterback job on the slate.' }
      ],
      note: 'Generated from the research objects. Nothing here is a pick; a game appears because of what EdgeDesk knows about it, not because it should be bet.'
    };
  };

  /* =================================================================
     RECORD — immutable, filterable, process kept apart from outcome
     rows come from record/football/cfb_<season>.json: the number EdgeDesk
     PUBLISHED before kickoff (pick), graded against the close and final.
     ================================================================= */
  T.recordRows = function (games, opts) {
    opts = opts || {};
    var out = [];
    Object.keys(games || {}).forEach(function (id) {
      var r = games[id];
      if (!r || !r.grade || r.grade.status !== 'GRADED' || !r.pick || !r.close || !r.final) return;
      var pickLine = num(r.pick.home_line), close = num(r.close.home_line);
      var fm = num(r.final.home_score) != null && num(r.final.away_score) != null ? r.final.home_score - r.final.away_score : null;
      var sp = r.grade.spread || {}, gapClose = pickLine != null && close != null ? close - pickLine : null;   /* + = model likes home more */
      var side = sp.side || (gapClose > 0 ? 'home' : (gapClose < 0 ? 'away' : null));
      /* the record stores CLV as {side, market, close, gap, pts}; pts is the
         points the market moved toward the model's side (a bare number is
         accepted from older rows) */
      var clvOf = function (c) { if (!c || c.spread == null) return null; return num(c.spread) != null ? c.spread : (c.spread && num(c.spread.pts) != null ? c.spread.pts : null); };
      var clv = clvOf(r.grade.clv_pick); if (clv == null) clv = clvOf(r.grade.clv_entry);
      var clvEntry = clvOf(r.grade.clv_entry);
      var result = sp.result || null;
      var process = clv == null ? 'UNKNOWN' : (clv > 0 ? 'GOOD PROCESS' : (clv < 0 ? 'BAD PRICE' : 'NEUTRAL PRICE'));
      var outcome = result === 'win' ? 'WON' : (result === 'loss' ? 'LOST' : (result === 'push' ? 'PUSH' : '—'));
      var fav = side && close != null ? ((side === 'home' && close < 0) || (side === 'away' && close > 0) ? 'favorite' : (close === 0 ? 'pickem' : 'underdog')) : null;
      var rel = r.pick.reliability && num(r.pick.reliability.score) != null ? r.pick.reliability.score : (r.reliability ? num(r.reliability.score) : null);
      out.push({ game_id: String(id), week: r.week, kickoff: r.kickoff, matchup: r.away + ' @ ' + r.home, home: r.home, away: r.away,
        conference: r.home_conference === r.away_conference ? r.home_conference : 'non-conference', matchup_type: r.matchup_type || null,
        model_version: r.pick.model_version || r.model_version || null,
        frozen_home_line: pickLine, frozen_at: r.pick.at, first_home_line: r.first ? num(r.first.home_line) : null,
        market_at_entry: r.entry && r.entry.market && num(r.entry.market.home_line) != null ? r.entry.market.home_line : null,
        market_at_pick: r.market_pick && num(r.market_pick.home_line) != null ? r.market_pick.home_line : null,
        close_home_line: close, close_source: r.close.source || null, final_margin: fm,
        final_text: r.away + ' ' + r.final.away_score + ' — ' + r.home + ' ' + r.final.home_score,
        side: side, side_team: side === 'home' ? r.home : (side === 'away' ? r.away : null),
        gap_vs_close: gapClose == null ? null : r2(Math.abs(gapClose)), role: fav,
        ats: outcome, clv: clv, clv_entry: clvEntry, clv_basis: r.grade.clv_pick && r.grade.clv_pick.spread ? 'pick' : (clvEntry != null ? 'entry' : null), process: process, quadrant: process === 'UNKNOWN' ? 'UNKNOWN / ' + outcome : process + ' / ' + outcome,
        status_at_pick: gapClose != null && Math.abs(gapClose) >= 2 ? 'LEAN (record rule: gap ≥ 2)' : 'PASS (record rule)',
        status_basis: 'derived from the published record rule; the terminal status is stored from the terminal’s first build on',
        reliability: rel, win_prob: num(r.pick.home_win_prob), su_home_won: fm == null ? null : (fm > 0 ? 1 : (fm < 0 ? 0 : null)),
        model_error: r.grade.error ? num(r.grade.error.model_margin_err) : null, close_error: r.grade.error ? num(r.grade.error.close_margin_err) : null,
        beyond_guard: !!r.grade.beyond_guard });
    });
    out.sort(function (a, c) { return (ms(c.kickoff) || 0) - (ms(a.kickoff) || 0); });
    return out;
  };
  T.RECORD_FILTERS = {
    bet: function (r) { return /^BET/.test(r.status_at_pick); },
    lean: function (r) { return /^LEAN/.test(r.status_at_pick); },
    gap_2_4: function (r) { return r.gap_vs_close != null && r.gap_vs_close >= 2 && r.gap_vs_close < 4; },
    gap_4_7: function (r) { return r.gap_vs_close != null && r.gap_vs_close >= 4 && r.gap_vs_close < 7; },
    gap_7: function (r) { return r.gap_vs_close != null && r.gap_vs_close >= 7; },
    rel_80: function (r) { return r.reliability != null && r.reliability >= 80; },
    rel_lt60: function (r) { return r.reliability != null && r.reliability < 60; },
    favorite: function (r) { return r.role === 'favorite'; },
    underdog: function (r) { return r.role === 'underdog'; },
    conference: function (r) { return r.matchup_type === 'conference'; },
    nonconference: function (r) { return r.matchup_type && r.matchup_type !== 'conference'; }
  };
  T.recordSummary = function (rows) {
    var w = 0, l = 0, p = 0, clvN = 0, clvSum = 0, clvPos = 0, byV = {};
    rows.forEach(function (r) {
      if (r.ats === 'WON') w++; else if (r.ats === 'LOST') l++; else if (r.ats === 'PUSH') p++;
      if (r.clv != null) { clvN++; clvSum += r.clv; if (r.clv > 0) clvPos++; }
      byV[r.model_version || 'unknown'] = (byV[r.model_version || 'unknown'] || 0) + 1;
    });
    var n = w + l;
    return { n: rows.length, ats: { w: w, l: l, p: p, pct: n ? r1(100 * w / n) : null, ci: wilson(w, n).map(function (x) { return x == null ? null : r1(100 * x); }), break_even_pct: 52.4 },
      clv: { n: clvN, avg: clvN ? r2(clvSum / clvN) : null, positive_pct: clvN ? r1(100 * clvPos / clvN) : null },
      versions: byV, sufficient: n >= T.CONFIG.history_min_n,
      note: n >= T.CONFIG.history_min_n ? null : 'Under ' + T.CONFIG.history_min_n + ' graded games: shown, but too few to read as a rate.' };
  };
  /* "When EdgeDesk says 55%, it happened X%": the win probability, which the
     record stores exactly */
  T.calibration = function (rows, minN) {
    minN = minN || T.CONFIG.history_min_n;
    var edges = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0001], bins = [];
    for (var i = 0; i < edges.length - 1; i++) bins.push({ lo: edges[i], hi: edges[i + 1], n: 0, sum_p: 0, hits: 0 });
    rows.forEach(function (r) {
      if (r.win_prob == null || r.su_home_won == null) return;
      var p = r.win_prob >= 0.5 ? r.win_prob : 1 - r.win_prob, hit = r.win_prob >= 0.5 ? r.su_home_won : 1 - r.su_home_won;
      for (var j = 0; j < bins.length; j++) if (p >= bins[j].lo && p < bins[j].hi) { bins[j].n++; bins[j].sum_p += p; bins[j].hits += hit; break; }
    });
    return { what: 'EdgeDesk’s published win probability for its favourite vs how often that team won', min_n: minN,
      rows: bins.map(function (x) {
        var label = Math.round(100 * x.lo) + '–' + Math.round(100 * Math.min(1, x.hi)) + '%';
        return { bucket: label, n: x.n, predicted: x.n ? r1(100 * x.sum_p / x.n) : null, observed: x.n ? r1(100 * x.hits / x.n) : null,
          ci: wilson(x.hits, x.n).map(function (v) { return v == null ? null : r1(100 * v); }), shown: x.n >= minN };
      }),
      cover_note: 'Cover-probability calibration is not yet measurable for the champion: the published record does not store the cover probability at the time. The terminal stores it from its first build on.' };
  };
  /* EdgeDesk pure vs opener vs close */
  T.benchmark = function (rows, openers) {
    var mE = [], cE = [], clv = [], toward = 0, tn = 0;
    rows.forEach(function (r) {
      if (r.model_error != null && r.close_error != null) { mE.push(Math.abs(r.model_error)); cE.push(Math.abs(r.close_error)); }
      if (r.clv != null) { clv.push(r.clv); tn++; if (r.clv > 0) toward++; }
    });
    function mean(a) { return a.length ? r2(a.reduce(function (s, x) { return s + x; }, 0) / a.length) : null; }
    var o = openers || { n: 0 };
    return { n: mE.length, model_mae: mean(mE), close_mae: mean(cE),
      model_beat_close_share: mE.length ? r1(100 * mE.filter(function (x, i) { return x < cE[i]; }).length / mE.length) : null,
      opener: o,
      movement_toward: { n: tn, pct: tn ? r1(100 * toward / tn) : null, basis: 'the share of games where the market moved toward EdgeDesk’s side from its recorded number to the close (CLV > 0)' },
      clv: { n: clv.length, avg: mean(clv) },
      note: 'The evidence that matters: does EdgeDesk’s number sit closer to the final than the close does, and does the market move toward it? Samples are printed; nothing is rounded up to a claim.' };
  };
  /* POSTGAME — why the projection held or missed. Research hypotheses only. */
  T.postmortem = function (r) {
    if (!r || r.model_error == null || r.close_error == null) return { available: false, class: 'UNKNOWN' };
    var me = Math.abs(r.model_error), ce = Math.abs(r.close_error), cls, text;
    if (r.beyond_guard) { cls = 'DATA_PROBLEM'; text = 'EdgeDesk’s number was past the guard bound from the close: a data problem is the likelier cause.'; }
    else if (me <= ce) { cls = 'PROJECTION_HELD'; text = 'EdgeDesk’s number was ' + (ce - me).toFixed(1) + ' pts closer to the final than the close.'; }
    else if (me - ce >= 7) { cls = 'BAD_PROJECTION'; text = 'The close was ' + (me - ce).toFixed(1) + ' pts closer to the final: the market saw something EdgeDesk did not.'; }
    else if (me >= 14 && ce >= 14) { cls = 'BAD_VARIANCE'; text = 'Both EdgeDesk and the close missed by 14+ pts: the game itself was an outlier.'; }
    else { cls = 'UNKNOWN'; text = 'EdgeDesk missed by ' + me.toFixed(1) + ' pts and the close by ' + ce.toFixed(1) + ': no single classification fits.'; }
    return { available: true, class: cls, text: text, model_error: r2(me), close_error: r2(ce),
      not_measured: ['turnover margin (no box-score turnovers in the record)', 'unexpected player events (no kickoff inactive lists)'],
      note: 'A postmortem is a research hypothesis. It changes nothing in the production model; only a person promotes a change.' };
  };

  /* HISTORICAL CONTEXT for one game from the graded record */
  T.historicalContext = function (rows, o, cfg) {
    cfg = cfg || T.CONFIG;
    if (!o.disagreement.available) return { available: false, reason: 'no disagreement to place in history' };
    var gap = o.disagreement.points, sets = [];
    function stat(label, filter) {
      var rs = rows.filter(filter), w = rs.filter(function (r) { return r.ats === 'WON'; }).length, l = rs.filter(function (r) { return r.ats === 'LOST'; }).length;
      var n = w + l, cl = rs.filter(function (r) { return r.clv != null; });
      sets.push({ label: label, n: n, w: w, l: l, pct: n ? r1(100 * w / n) : null, ci: wilson(w, n).map(function (v) { return v == null ? null : r1(100 * v); }),
        clv_n: cl.length, clv_avg: cl.length ? r2(cl.reduce(function (s, r) { return s + r.clv; }, 0) / cl.length) : null,
        shown: n >= cfg.history_min_n });
    }
    var lo = gap < 2 ? 0 : (gap < 4 ? 2 : (gap < 7 ? 4 : 7)), hi = lo === 0 ? 2 : (lo === 2 ? 4 : (lo === 4 ? 7 : 99));
    stat('EdgeDesk ' + lo + (hi < 99 ? '–' + hi : '+') + ' pts off the close', function (r) { return r.gap_vs_close != null && r.gap_vs_close >= lo && r.gap_vs_close < hi; });
    var role = o.price.available && o.price.current ? (o.price.current.line < 0 ? 'favorite' : 'underdog') : null;
    if (role) stat('EdgeDesk on the ' + role + ' with a 2+ gap', function (r) { return r.role === role && r.gap_vs_close != null && r.gap_vs_close >= 2; });
    if (o.game.matchup_type) stat(o.game.matchup_type === 'conference' ? 'Conference games, 2+ gap' : 'Non-conference games, 2+ gap', function (r) { return (o.game.matchup_type === 'conference' ? r.matchup_type === 'conference' : r.matchup_type !== 'conference') && r.gap_vs_close != null && r.gap_vs_close >= 2; });
    var rel = o.data_quality.reliability;
    if (rel != null) { var rb = rel >= 80 ? 80 : (rel >= 60 ? 60 : 0); stat('Reliability ' + rb + (rb === 80 ? '+' : (rb === 60 ? '–79' : '–59')) + ', 2+ gap', function (r) { return r.reliability != null && (rb === 80 ? r.reliability >= 80 : (rb === 60 ? r.reliability >= 60 && r.reliability < 80 : r.reliability < 60)) && r.gap_vs_close != null && r.gap_vs_close >= 2; }); }
    return { available: true, sets: sets, min_n: cfg.history_min_n, model: 'the champion’s published pregame numbers (record/football), graded against the close',
      note: 'A set under ' + cfg.history_min_n + ' games is counted but not read as a rate. 52.4% is break-even at -110.' };
  };

  /* =================================================================
     WATCHLIST and PRICE TARGETS — stored cleanly, compared honestly
     ================================================================= */
  T.watchEntry = function (o, opts) {
    opts = opts || {};
    var F = o.price, side = opts.side || (F.available ? F.side : null);
    var target = opts.target_line != null ? opts.target_line : (F.available && F.preferred_entry ? F.preferred_entry.line : null);
    return { v: 1, game_id: o.game_id, kickoff: o.kickoff, matchup: o.game.away + ' @ ' + o.game.home, side: side,
      team: side === 'home' ? o.game.home : (side === 'away' ? o.game.away : null),
      target_line: target, target_price: opts.target_price != null ? opts.target_price : (F.reference_price || -110),
      saved_at: iso(opts.now || Date.now()), fair_home_margin: o.edgedesk.available ? o.edgedesk.home_margin : null,
      market_home_line: o.market.consensus_home_line, status: o.status.key,
      qb: o.qb ? { home: o.qb.home ? { player: o.qb.home.player, status: o.qb.home.status } : null, away: o.qb.away ? { player: o.qb.away.player, status: o.qb.away.status } : null } : null };
  };
  T.watchDiff = function (e, o, books) {
    var out = [];
    if (!e || !o) return out;
    if (e.fair_home_margin != null && o.edgedesk.available && Math.abs(o.edgedesk.home_margin - e.fair_home_margin) >= 0.25)
      out.push({ kind: 'FAIR', text: 'EdgeDesk moved ' + Math.abs(o.edgedesk.home_margin - e.fair_home_margin).toFixed(1) + ' pts toward ' + (o.edgedesk.home_margin > e.fair_home_margin ? o.game.home : o.game.away) + ' since you saved it.' });
    if (e.market_home_line != null && o.market.consensus_home_line != null && Math.abs(o.market.consensus_home_line - e.market_home_line) >= 0.25)
      out.push({ kind: 'MARKET', text: 'The market moved ' + Math.abs(o.market.consensus_home_line - e.market_home_line).toFixed(1) + ' pts toward ' + (o.market.consensus_home_line < e.market_home_line ? o.game.home : o.game.away) + '.' });
    if (e.qb && o.qb) ['home', 'away'].forEach(function (s) {
      var a = e.qb[s] || {}, c = o.qb[s] || {};
      if ((a.player || null) !== (c.player || null) || (a.status || null) !== (c.status || null)) out.push({ kind: 'QB', text: (s === 'home' ? o.game.home : o.game.away) + ' QB: ' + (a.player || '—') + ' → ' + (c.player || '—') + ' (' + (c.status || '—') + ').' });
    });
    if (e.status && e.status !== o.status.key) out.push({ kind: 'STATUS', text: 'Status ' + e.status + ' → ' + o.status.key + '.' });
    var best = T.bestForBooks(o, books || null);
    var q = best && e.side ? best[e.side] : null;
    if (q && e.target_line != null) {
      var reached = q.line > e.target_line - 1e-9 && (payout(q.price) || 0) >= (payout(e.target_price) || 0) - 1e-9;
      out.push({ kind: reached ? 'TARGET_REACHED' : 'TARGET', text: reached ? 'Your target is available: ' + e.team + ' ' + bookText(q.line) + ' ' + priceText(q.price) + ' at ' + q.book + '.'
        : 'Best ' + e.team + ' number ' + bookText(q.line) + ' ' + priceText(q.price) + ' (' + q.book + '); your target is ' + bookText(e.target_line) + ' ' + priceText(e.target_price) + '.' });
    }
    return out;
  };
  /* PERSONAL BOOKS — the best number a user can actually get */
  T.bestForBooks = function (o, books) {
    var allow = books && books.length ? books.map(function (x) { return String(x).toLowerCase(); }) : null;
    var qs = (o.market.quotes || []).filter(function (q) { return q.fresh && (!allow || allow.indexOf(String(q.book).toLowerCase()) >= 0); });
    function best(side) {
      var c = qs.filter(function (q) { return num(side === 'home' ? q.price_home : q.price_away) != null; });
      if (!c.length) return null;
      c.sort(function (x, y) {
        var lx = side === 'home' ? x.home_line : x.away_line, ly = side === 'home' ? y.home_line : y.away_line;
        if (ly !== lx) return ly - lx;
        return (payout(side === 'home' ? y.price_home : y.price_away) || 0) - (payout(side === 'home' ? x.price_home : x.price_away) || 0);
      });
      var q = c[0];
      return { book: q.book, line: side === 'home' ? q.home_line : q.away_line, price: side === 'home' ? q.price_home : q.price_away };
    }
    return { home: best('home'), away: best('away'), books_considered: allow ? allow : 'all', none_available: !qs.length };
  };

  /* =================================================================
     THE RESEARCH ASSISTANT — answers only from the research objects.
     Every claim carries its source; what EdgeDesk does not hold is
     UNKNOWN. It reads the status and can never write it.
     ================================================================= */
  function fact(claim, source, updated, confidence) { return { claim: claim, source: source || 'research object', updated: updated || null, confidence: confidence || 'stored' }; }
  T.INTENTS = [
    { id: 'invent_guard', re: /\b(sharp|sharps|steam|public (money|betting|%)|handle|tickets?|% of (the )?(bets|money)|percent(age)? of (the )?(bets|money|tickets|handle)|consensus picks?|betting splits?|splits)\b/i },
    { id: 'injury', re: /\b(injur|hurt|out for|questionable|doubtful|probable|inactive)/i },
    { id: 'weather', re: /\b(weather|wind|rain|snow|temperature|forecast)\b/i },
    { id: 'scheme', re: /\b(scheme|play ?call|coordinator|game ?plan|motivation|revenge|trap game|look.?ahead)\b/i },
    { id: 'what_changed', re: /\b(what changed|since (monday|tuesday|wednesday|thursday|friday|open|last)|moved? since|change[sd]?)\b/i },
    { id: 'invalidate', re: /\b(make (this|it) a pass|invalidate|wrong|what would have to|thesis|break (the|this))\b/i },
    { id: 'market_moved', re: /\b(market (moved|move|movement)|line (moved|move|movement)|has the (market|line))\b/i },
    { id: 'price', re: /\b(price|still good|bettable|value|ev\b|expected value|worth betting|bet (this|it|now))\b/i },
    { id: 'sensitivity', re: /\b(sensitiv|how much would|if .{0,40}(out|confirmed|starts)|scenario)\b/i },
    { id: 'player', re: /\b(player|quarterback|qb|position|who matters|starter)\b/i },
    { id: 'similar', re: /\b(similar|history|historically|in the past|comparable|track record|how has edgedesk)\b/i },
    { id: 'models', re: /\b(model agreement|models? (agree|disagree)|consensus of models|component models?|ensemble)\b/i },
    { id: 'why', re: /\b(why|like|see that|off (the )?market|disagree|lean|number)\b/i }
  ];
  T.SLATE_INTENTS = [
    { id: 'highest_agreement', re: /\bhighest (model )?agreement|most (model )?agreement|models agree most\b/i },
    { id: 'deteriorated', re: /\b(deteriorat|lines? .*gone|value .*gone|decay)/i },
    { id: 'biggest_verified', re: /\b(biggest|largest) (verified )?(discrepanc|disagreement|gap)/i },
    { id: 'queue', re: /\b(what should i research|research queue|most important games|top games)\b/i }
  ];
  function intentOf(q, list) { for (var i = 0; i < list.length; i++) if (list[i].re.test(q)) return list[i].id; return null; }
  function unknown(what, why) {
    return { intent: 'unknown', unknown: true, text: 'UNKNOWN. ' + what + ' ' + why, facts: [], status: null };
  }
  /* the EdgeDesk Read (lib/edgedesk_read.js), when loaded: it answers the PRICE questions */
  function readApi() {
    var g = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null);
    if (g && g.EDRead) return g.EDRead;
    if (typeof require === 'function') { try { return require('./edgedesk_read.js'); } catch (e) { return null; } }
    return null;
  }
  T.READ_INTENTS = ['main_or_alt', 'juice', 'bet_now', 'wait', 'worst_number', 'pass_price', 'best_book', 'value_gone', 'edge_kind', 'why_not'];
  T.ask = function (question, o, slate) {
    var q = String(question || '').trim();
    var s = null;
    if (!o) {
      var si = intentOf(q, T.SLATE_INTENTS);
      if (si && slate) return T.askSlate(si, slate);
      return unknown('No game is loaded.', 'Open a game, or ask about the slate: “which games have the highest model agreement?”, “which lines have deteriorated?”, “what are the biggest verified discrepancies?”.');
    }
    /* price questions go to the Read — after the guard that refuses sharp money, splits and handle */
    if (o.read && intentOf(q, [T.INTENTS[0]]) !== 'invent_guard') {
      var RDX = readApi();
      if (RDX) {
        var ri = null;
        for (var k = 0; k < RDX.INTENTS.length; k++) if (RDX.INTENTS[k].re.test(q)) { ri = RDX.INTENTS[k].id; break; }
        if (ri && T.READ_INTENTS.indexOf(ri) >= 0) {
          var ra = RDX.ask(q, o.read);
          if (ra) return { intent: 'read_' + ra.intent, unknown: false, status: o.status ? o.status.key : null, read: true,
            facts: (ra.facts || []).map(function (f) { return fact(f.claim, f.source, f.updated, f.confidence); }), text: ra.text };
        }
      }
    }
    var intent = intentOf(q, T.INTENTS) || 'why';
    var g = o.game, A = o.edgedesk, C = o.disagreement, F = o.price, S = o.status;
    var st = { key: S.key, label: S.label };                         /* read, never written */
    var facts = [], lines = [];
    var updA = A.prediction_ts || o.trust.model_updated_at, updB = o.market.as_of;
    function say(t, f) { lines.push(t); if (f) facts.push(f); }
    switch (intent) {
      case 'invent_guard':
        return { intent: intent, unknown: true, status: st, facts: [],
          text: 'UNKNOWN. EdgeDesk holds no betting-split, handle, ticket or “sharp money” data, and will not estimate it. What it does hold: the market moved ' + (o.market.move_since_open ? o.market.move_since_open.text : '— (no opener captured)') + '.' };
      case 'injury': {
        var av = o.risks.items.filter(function (i) { return /^availability_|^qb_/.test(i.key); });
        if (!av.length && !o.qb) return unknown('EdgeDesk has no injury report for this game.', 'It will not guess a player’s status.');
        say('What EdgeDesk holds on availability:', null);
        ['home', 'away'].forEach(function (k) { var x = o.qb && o.qb[k]; if (x) say('• ' + (k === 'home' ? g.home : g.away) + ' QB ' + (x.player || '—') + ': ' + String(x.status || 'unknown').toLowerCase().replace(/_/g, ' ') + (x.confirmed ? ' (confirmed)' : ' (not confirmed)') + '.', fact('QB ' + (x.player || '—') + ' ' + x.status, x.source || 'starter context', x.as_of || null, x.confirmed ? 'confirmed' : 'expected')); });
        av.filter(function (i) { return /^availability_/.test(i.key); }).forEach(function (i) { say('• ' + i.text, fact(i.text, i.source, updA)); });
        say('Anything not listed is UNKNOWN to EdgeDesk; it does not infer injuries.', null);
        break;
      }
      case 'weather':
        return { intent: intent, unknown: !(o.sensitivity.rows || []).some(function (r) { return /^wind_/.test(r.key); }), status: st, facts: [fact('weather moves no spread in production', 'football/cfb_v2/params.js weather', null, 'declared')],
          text: 'EdgeDesk has no verified kickoff forecast in this research object, so the weather itself is UNKNOWN here. What is known: weather moves no spread in production — V1 uses it for totals only and V2.1 widens the range only. ' + ((o.sensitivity.rows || []).filter(function (r) { return r.key === 'wind_25'; }).map(function (r) { return 'At 25 mph wind the range widens by ' + (r.sigma_delta || 0).toFixed(2) + ' pts of SD.'; })[0] || '') };
      case 'scheme':
        return unknown('EdgeDesk does not model scheme, play-calling, motivation or “spots”.', 'It will not describe them. It can tell you what its unit data measures — ask “which positions are driving this matchup?”.');
      case 'what_changed': {
        var wc = o.what_changed;
        if (!wc.available) return unknown('Only one EdgeDesk number is on file for this game.', wc.reason || '');
        say(wc.text, fact(wc.text, 'EdgeDesk projection history', wc.to.at));
        wc.rows.forEach(function (r) { say('• ' + r.text, fact(r.text, 'engine terms / state', wc.to.at, wc.attribution === 'exact' ? 'exact' : 'stored')); });
        if (wc.attribution_text) say(wc.attribution_text, null);
        if (wc.market) say(wc.market.text, fact(wc.market.text, 'Model Lab market capture', updB));
        break;
      }
      case 'invalidate': {
        say('It becomes a PASS if any of these happens (status now: ' + S.label + '):', null);
        if (F.available && F.pass_beyond) say('• The price moves to ' + F.pass_beyond.text + ' (the model edge falls under ' + pp(T.CONFIG.min_probability_edge, 0) + ').', fact('pass beyond ' + F.pass_beyond.text, 'price curve (champion margin distribution)', updB));
        (o.reconcile.rows || []).slice(0, 3).forEach(function (r) { say('• ' + r.text + (r.sds_needed != null ? ' (' + r.sds_needed.toFixed(1) + ' SD of that input)' : '') + '.', fact(r.text, r.source, updA, 'measured')); });
        o.risks.items.filter(function (i) { return i.severity === 'high'; }).slice(0, 2).forEach(function (i) { say('• ' + i.text, fact(i.text, i.source, updA)); });
        break;
      }
      case 'market_moved': {
        var mv = o.market.move_since_open;
        if (!mv && o.timeline.market.length < 2) return unknown('No opener and only one market capture are on file.', 'EdgeDesk cannot say how the market moved.');
        if (mv) say('The market ' + mv.text + '.', fact(mv.text, 'Model Lab market capture', updB));
        if (C.market_direction_text) say(C.market_direction_text, null);
        if (o.edge_decay.available && o.edge_decay.verdict_text) say('Edge decay: ' + o.edge_decay.verdict_text + ' ' + (o.edge_decay.text || ''), fact(o.edge_decay.text || o.edge_decay.verdict_text, 'model vs market timeline', updB));
        if (o.market_check.triggered) say(o.market_check.verdict_text, fact(o.market_check.verdict_text, 'market check', updB));
        break;
      }
      case 'price': {
        if (!F.available || !F.current) return unknown('There is no live priced quote on EdgeDesk’s side.', F.reason || '');
        say('At ' + F.current.text + ': cover ' + pct(F.current.cover, 1) + ' vs break-even ' + pct(F.current.break_even, 1) + ' (' + pp(F.current.edge) + '), model EV ' + (100 * F.current.ev).toFixed(1) + '%.', fact('cover ' + pct(F.current.cover, 1), 'champion margin distribution', updB, 'model'));
        if (F.preferred_entry) say('Preferred: ' + F.preferred_entry.text + '. Bettable to: ' + (F.bettable_to ? F.bettable_to.text : '—') + '. Pass beyond: ' + (F.pass_beyond ? F.pass_beyond.text : '—') + '.', fact('targets', 'price curve', updB, 'model'));
        say('Status: ' + S.label + ' — ' + S.reason, null);
        if (S.why_not_bet.length) say('Not a certified bet: ' + S.why_not_bet[0].text, null);
        break;
      }
      case 'sensitivity': {
        if (!o.sensitivity.available) return unknown('No measured sensitivity is published for this game.', o.sensitivity.reason || '');
        o.sensitivity.rows.slice(0, 8).forEach(function (r) { say('• ' + r.label + ': ' + r.fair_text + (r.kind === 'variance' ? ' (range ' + (r.sigma_delta >= 0 ? '+' : '') + (r.sigma_delta || 0).toFixed(2) + ' SD)' : ' (' + signed(r.delta, 1) + ')') + '.', fact(r.label, r.basis, updA, 'model')); });
        break;
      }
      case 'player': {
        var qb = o.qb || {};
        ['home', 'away'].forEach(function (k) { var x = qb[k]; if (x) say((k === 'home' ? g.home : g.away) + ' QB: ' + (x.player || '—') + ', ' + String(x.status || 'unknown').toLowerCase().replace(/_/g, ' ') + (x.confirmed ? ' (confirmed)' : '') + (x.epa != null ? ', ' + x.epa.toFixed(3) + ' EPA/dropback this season (n=' + x.dropbacks + ')' : '') + '.', fact('QB ' + x.player, x.source || 'starter context', x.as_of, x.confirmed ? 'confirmed' : 'expected')); });
        var qbSens = (o.sensitivity.rows || []).filter(function (r) { return /^qb_out_/.test(r.key); });
        qbSens.forEach(function (r) { say('• ' + r.label + ' → ' + r.fair_text + ' (' + signed(r.delta, 2) + ').', fact(r.label, r.basis, updA, 'model')); });
        if (o.matchup.available) {
          var big = o.matchup.cards.slice().sort(function (x, y) { return Math.abs(y.net_sd) - Math.abs(x.net_sd); })[0];
          if (big) say('The largest unit mismatch is the ' + big.label.toLowerCase() + ': ' + big.text + '.', fact(big.text, 'football/matchup/metrics.json', null, big.confidence));
        }
        say('EdgeDesk does not rank individual non-QB players’ value; anything beyond the above is UNKNOWN.', null);
        break;
      }
      case 'similar': {
        var h = o.historical;
        if (!h || !h.available) return unknown('No comparable history is on file.', h && h.reason ? h.reason : '');
        h.sets.forEach(function (x) { say('• ' + x.label + ': ' + (x.shown ? x.w + '-' + x.l + ' ATS (' + x.pct + '%, 95% CI ' + x.ci[0] + '–' + x.ci[1] + '%), n=' + x.n : 'n=' + x.n + ' — too few to read as a rate'), fact(x.label + ' n=' + x.n, 'record/football (published pregame numbers vs the close)', null, x.shown ? 'measured' : 'insufficient sample')); });
        say(h.note, null);
        break;
      }
      case 'models': {
        var K = o.consensus;
        if (!K.available) return unknown('Fewer than two model numbers exist for this game.', '');
        K.rows.forEach(function (r) { say('• ' + r.label + ': ' + r.text, fact(r.label + ' ' + r.text, 'Model Lab', updA, 'model')); });
        say('Agreement ' + K.agreement.tier + ' (SD ' + K.sd.toFixed(1) + ' pts).', null);
        K.why_disagree.forEach(function (t) { say(t, null); });
        break;
      }
      default: {
        if (!A.available) return unknown('EdgeDesk has no projection for this game.', A.reason || '');
        say('EdgeDesk: ' + A.fair_text + '. Market: ' + (o.market.consensus_text || 'none') + '. ' + (C.available ? 'Gap: ' + C.text + '.' : ''), fact(A.fair_text, 'champion model ' + A.model_version, updA, 'model'));
        if (o.why.available) o.why.rows.filter(function (r) { return Math.abs(r.points) >= 0.5; }).slice(0, 4).forEach(function (r) { say('• ' + r.label + ': ' + r.text + '.', fact(r.label + ' ' + r.points, 'engine additive term', updA, 'exact')); });
        else if (o.why.v2_drivers) o.why.v2_drivers.rows.slice(0, 3).forEach(function (r) { say('• (V2.1) ' + r.label + ': ' + signed(Math.abs(r.points)) + ' toward ' + r.favors + '.', fact(r.label, 'V2.1 drivers', updA, 'model')); });
        if (o.matchup.available) o.matchup.cards.filter(function (c) { return c.favors_side === C.toward && c.magnitude !== 'even'; }).slice(0, 2).forEach(function (c) { say('• Unit data: ' + c.label + ' — ' + c.text + '.', fact(c.text, 'football/matchup/metrics.json', null, c.confidence)); });
        if (C.available && C.class === 'MAJOR') say('Verification: ' + String(C.verification).replace(/_/g, ' ') + '.', fact('verification ' + C.verification, 'integrity gate', updB));
        say('Status: ' + S.label + ' — ' + S.reason, null);
      }
    }
    return { intent: intent, unknown: false, status: st, facts: facts, text: lines.join('\n') };
  };
  T.askSlate = function (intent, slate) {
    var objs = slate || [], lines = [], facts = [];
    if (intent === 'highest_agreement') {
      objs.filter(function (o) { return o.consensus.available && o.consensus.sd != null; }).sort(function (a, c) { return a.consensus.sd - c.consensus.sd; }).slice(0, 5)
        .forEach(function (o) { lines.push('• ' + o.game.away + ' @ ' + o.game.home + ': SD ' + o.consensus.sd.toFixed(1) + ' pts across ' + o.consensus.n_independent + ' models (' + o.status.label + ').'); facts.push(fact('SD ' + o.consensus.sd, 'model consensus', o.built_at)); });
    } else if (intent === 'deteriorated') {
      objs.filter(function (o) { return o.edge_decay.available && (o.edge_decay.verdict === 'MOST_GONE' || o.edge_decay.verdict === 'PARTIAL' || o.edge_decay.verdict === 'REVERSED'); })
        .forEach(function (o) { lines.push('• ' + o.game.away + ' @ ' + o.game.home + ': ' + o.edge_decay.verdict_text + ' ' + o.edge_decay.text); facts.push(fact(o.edge_decay.text, 'model vs market timeline', o.built_at)); });
      if (!lines.length) lines.push('No disagreement has decayed on the current slate.');
    } else if (intent === 'biggest_verified') {
      var v = objs.filter(function (o) { return o.disagreement.verified; }).sort(function (a, c) { return c.disagreement.points - a.disagreement.points; });
      v.slice(0, 5).forEach(function (o) { lines.push('• ' + o.game.away + ' @ ' + o.game.home + ': ' + o.disagreement.text + ' (verified).'); facts.push(fact(o.disagreement.text, 'integrity gate', o.built_at)); });
      if (!v.length) {
        lines.push('No gap passed every integrity check. The largest unverified gaps are INVESTIGATE, not verified:');
        objs.filter(function (o) { return o.disagreement.class === 'MAJOR'; }).sort(function (a, c) { return c.disagreement.points - a.disagreement.points; }).slice(0, 3)
          .forEach(function (o) { lines.push('• ' + o.game.away + ' @ ' + o.game.home + ': ' + o.disagreement.text + ' (' + String(o.disagreement.verification).toLowerCase().replace(/_/g, ' ') + ').'); });
      }
    } else {
      T.queue(objs).slice(0, 5).forEach(function (o) { lines.push('• ' + o.game.away + ' @ ' + o.game.home + ' — ' + o.status.label + ', research interest ' + o.fields.research_interest.score + '.'); });
    }
    return { intent: intent, unknown: false, status: null, facts: facts, text: lines.join('\n') };
  };

  /* =================================================================
     THE LLM BOUNDARY'S INPUT. The AI desk explains a CFB game only through
     supabase/functions/edgedesk_ai/_cfb_explain.js (cfbFacts -> buildPrompt
     -> auditExplanation). This hands that boundary the canonical research
     object, so the words an LLM is allowed to use — the status, the fair
     line, the market, the QB states — are exactly the ones this page shows.
     ================================================================= */
  T.explainSource = function (o) {
    var A = o.edgedesk, B = o.market, F = o.price, S = o.status;
    var qb = function (q) { return q ? { player_name: q.player, status: q.status, confirmed: !!q.confirmed } : null; };
    return {
      pure: A.available ? { home: o.game.home, away: o.game.away, kickoff: o.kickoff, neutral_site: o.game.neutral_site, week: o.week, season: o.season,
        model_version: A.model_version, projected_margin: A.home_margin, fair_spread_display: A.fair_text, home_win_prob: A.home_win_prob,
        intervals: A.interval_80 ? { p80: [A.interval_80.lo, A.interval_80.hi] } : null } : { home: o.game.home, away: o.game.away, kickoff: o.kickoff },
      decision: { status: S.key, side: F.available && F.side ? F.side.toUpperCase() : null,
        line_for_side: S.key === 'BET' && F.current ? F.current.line : null, price: S.key === 'BET' && F.current ? F.current.price : null,
        cover_probability: F.available && F.current && S.key !== 'INVESTIGATE' && S.key !== 'DATA_FAULT' ? F.current.cover : null,
        reasons: [S.reason], bet_enabled: !!(o.trust && o.trust.betting_enabled) },
      market: B.available && !B.stale ? { home_line: B.consensus_home_line, as_of: B.as_of, books: B.books_fresh, stale: false,
        actionable_status: B.books_fresh >= T.CONFIG.min_books ? 'ACTIONABLE' : 'MARKET_THIN' } : null,
      qb: { home: qb(o.qb && o.qb.home), away: qb(o.qb && o.qb.away) },
      data_quality: { status: o.data_quality.reliability == null ? null : (o.data_quality.reliability >= 80 ? 'GREEN' : (o.data_quality.reliability >= 60 ? 'YELLOW' : 'RED')), issues: [] },
      read: o.read || null
    };
  };

  /* =================================================================
     PRODUCT ANALYTICS — the event vocabulary. Engagement never touches a
     model: these events go to a UX store only (docs/cfb-terminal).
     ================================================================= */
  T.ANALYTICS_EVENTS = ['board_view', 'game_open', 'section_open', 'filter_apply', 'watch_add', 'watch_remove', 'target_set',
    'ask', 'record_view', 'record_filter', 'brief_view', 'why_view', 'feedback', 'export'];

  /* one-line export of a game's research card (no proprietary internals) */
  T.exportCard = function (o) {
    var s = o.summary;
    return [o.game.away + ' @ ' + o.game.home + ' · ' + (o.kickoff || '').slice(0, 16).replace('T', ' ') + ' UTC',
      'EdgeDesk fair: ' + s.model_says + ' · Market: ' + s.market_says,
      'Gap: ' + (s.gap || '—') + (o.disagreement.verified ? ' (VERIFIED)' : ''),
      'Why: ' + s.why, 'Risk: ' + s.risk, 'Price: ' + s.price,
      'Status: ' + s.status + ' — ' + s.status_reason,
      'Model ' + (o.edgedesk.model_version || '—') + ' · built ' + (o.built_at || '').slice(0, 16).replace('T', ' ') + ' UTC · research, not advice'].join('\n')
      + (o.read && readApi() ? '\n\n' + readApi().exportText(o.read) : '');
  };

  return T;
});

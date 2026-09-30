/* ===========================================================================
   EDGEDESK READ — one price-specific research read per game.
   docs/edgedesk-read/DESIGN.md

   The research terminal (lib/cfb_terminal.js) says what EdgeDesk makes the
   game, why, how sure it is and whether the gap survives the integrity checks.
   This layer answers the bettor's PRICE questions from those same numbers:

     what does the game cost, what should it cost, what is the probability at
     THIS line and THIS juice, what does the book require, is there enough
     difference to matter, is there a better way to express the same view
     (another book, an alternate spread), are we paying too much for safety,
     act now or wait, what price would make us stop, and what could make us
     wrong.

   WHAT THIS FILE NEVER DOES
     - it never computes a football number. The probability of every outcome
       at every line is read from the probability CURVE the build stored from
       the champion's own margin distribution (football/cfb_terminal/build.js
       buildReadCurve). Nothing here re-derives a margin, a sigma or a PMF.
     - it never lets the market into the football number. A market quote is
       only ever the price being judged. (The calibrated DECISION probability
       may shrink toward the market when a validated calibration says so —
       that is football/cfb_decision/decision.js decisionProbability, and the
       pure number beside it is never changed.)
     - it never certifies a bet. BET and BET EARLY need the governed decision
       engine's BET for that exact quote (decision.js decideQuote, fail
       closed); everything else is research. A user's own quote is never
       official and never enters the consensus.
     - it never uses an LLM or a narrative. Every word is built from a reason
       code and the numbers that triggered it.

   ODDS MATH has one home: football/cfb_decision/decision.js (americanToPayout,
   payoutToAmerican, breakEven, devig, expectedValue, decisionProbability,
   marketConfidence). This file calls it; tools/football/edgedesk_read.test.js
   pins parity with it and with lib/cfb_terminal.js.

   CONVENTIONS
     side         'home' | 'away'
     book line    what a book prints for the side: +6.5 = the side gets 6.5
     home margin  + = home wins by that many (the curve's axis)
     cushion      side line − EdgeDesk's fair line for that side (points)
     edge         cover probability used − break-even (probability points)

   Browser: window.EDRead (load football/cfb_decision/decision.js first).
   Node: require('./edgedesk_read.js'). ES5, no dependencies beyond decision.js.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDRead = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_read_v1';
  var SCHEMA = 'edgedesk_read_v1';

  var D = root && root.EDCfbDecision ? root.EDCfbDecision : null;
  if (!D && typeof require === 'function') { try { D = require('../football/cfb_decision/decision.js'); } catch (e) { D = null; } }
  function dec() { if (!D) throw new Error('EDRead needs EDCfbDecision (football/cfb_decision/decision.js) loaded first'); return D; }

  /* ------------------------------------------------------------- helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); return Math.round(x * m) / m; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function median(xs) { xs = xs.filter(isNum).slice().sort(function (a, b) { return a - b; }); if (!xs.length) return null; var m = Math.floor(xs.length / 2); return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; }
  function uniq(a) { var o = [], s = {}; (a || []).forEach(function (x) { var k = String(x); if (!s[k]) { s[k] = 1; o.push(x); } }); return o; }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function pct(p, dp) { return isNum(p) ? (100 * p).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function pp(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function ppAbs(x, dp) { return isNum(x) ? Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function evText(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + '%' : '—'; }
  function pts(x) { return isNum(x) ? Math.abs(x).toFixed(1) + ' pt' + (Math.abs(Math.abs(x) - 1) < 1e-9 ? '' : 's') : '—'; }
  /* a line as a book prints it: +6.5, -3, PK */
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < 1e-9) return 'PK'; var s = String(r(v, 1)).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : ''; }
  /* one sentence, one full stop: reasons from other layers often carry their own */
  function stop(t) { return String(t == null ? '' : t).replace(/[\s.]+$/, ''); }
  function halfPoint(x) { return isNum(x) && Math.abs(x * 2 - Math.round(x * 2)) < 1e-9; }
  function isInt(x) { return isNum(x) && Math.abs(x - Math.round(x)) < 1e-9; }
  function otherSide(s) { return s === 'home' ? 'away' : 'home'; }
  function bookKey(b) { return String(b == null ? '' : b).toLowerCase().replace(/^record:/, '').replace(/[^a-z0-9]/g, ''); }
  function isPseudoBook(b) { return /consensus/i.test(String(b || '')); }

  /* =================================================================
     THE RULES. Every threshold is an existing EdgeDesk threshold, named
     where it comes from. build.js passes the frozen decision policy's own
     values; the defaults below are those values at the time of writing.
     A PRESENTATION rule decides wording or order only, never a status.
     ================================================================= */
  var CONFIG = {
    /* cfb_decision_policy_v1 */
    min_probability_edge: 0.01,      /* the probability edge a price needs over break-even (DEV plateau) */
    ideal_probability_edge: 0.02,    /* the "ideal" entry the price targets use */
    min_ev: 0,                       /* declared floor on EV */
    stale_minutes: 180,              /* an older quote is not a price */
    max_price: -125,                 /* the declared price limit a governed BET must respect */
    reference_price: -110,           /* the price a line ladder is quoted at */
    min_books: 3,                    /* a consensus a bet can lean on */
    max_dispersion_iqr: 1.5,
    max_model_sd: 6,                 /* max_ensemble_sd: past it EdgeDesk's own models disagree too much */
    /* lib/cfb_terminal.js CONFIG */
    research_gap: 2, major_gap: 7,
    move_pts: 0.5,                   /* the smallest printed market move */
    typical_move_pts: 1.9,           /* football/validation/movement_cfb.json: held-out mean |open → close| (build passes the live value) */
    decay_most_gone: 0.4, decay_partial: 0.75, decay_grew: 1.1,
    quote_check_pts: 1,              /* lineShopping stale-candidate rule: a quote ≥ 1 pt off another current number is checked */
    book_edge_pts: 1,                /* lineShopping edge kind: a book ≥ 1 pt better than the consensus is a book-price edge */
    key_numbers: [3, 7, 10, 14],     /* keyNumbers primary: the four largest FBS final-margin shares */
    ladder_half_points: 6,           /* priceView curve_half_points */
    bettable_search_pts: 10,         /* decision.js priceTargets walks ten points either way */
    /* PRESENTATION: two EVs closer than this read as equivalent (0.05% of the stake) */
    ev_equivalent: 0.0005
  };
  function config(over) {
    var o = {}, k;
    for (k in CONFIG) if (has(CONFIG, k)) o[k] = CONFIG[k];
    if (over) for (k in over) if (has(over, k) && over[k] != null) o[k] = over[k];
    return o;
  }

  /* the vocabularies: one meaning each, and the words never used */
  var TIMING = {
    BET_EARLY: 'The governed decision engine certified this exact quote and a measurable reason says the number may not last: the market is moving toward EdgeDesk, or the next half point crosses a key number.',
    BET: 'The governed decision engine certified this exact quote. No measured reason to hurry, none to wait.',
    WAIT: 'Not now: a named piece of information is unresolved (a quarterback decision, a market too thin to trust). Never a forecast that the line will move.',
    PRICE_TARGET: 'EdgeDesk still disagrees with the market, but the current number does not clear the threshold. The target number would; it is within ordinary line movement. Never a promise that it appears.',
    PASS: 'No price that clears the threshold at any available number, or no disagreement worth acting on. The reason is printed.',
    PRICE_GONE: 'The football opinion is unchanged, but the number that made it value is gone: the first price cleared the threshold, the current one does not.',
    RESEARCH: 'The price clears EdgeDesk’s research threshold, but it is not a certified bet — the reason is printed (today: the cover probability is not calibrated for this model, or betting is disabled).',
    INVESTIGATE: 'A gap the integrity checks have not verified, a data fault, or a market quote that contradicts another current quote. Not priced as actionable.',
    NO_DECISION: 'Something required is missing, stale or malformed — the model, the probability curve, a current quote, or a valid price. EdgeDesk does not guess.'
  };
  var DECISION_OF_TIMING = { BET_EARLY: 'BET_EARLY', BET: 'BET', WAIT: 'WAIT', PRICE_TARGET: 'WAIT', PASS: 'PASS', PRICE_GONE: 'PASS',
    RESEARCH: 'RESEARCH_ONLY', INVESTIGATE: 'NO_DECISION', NO_DECISION: 'NO_DECISION' };
  var RESEARCH_STATUS = {
    VERIFIED_MAJOR_DISAGREEMENT: 'A 7+ point gap that passed every integrity check. Still not a bet by itself.',
    WORTH_RESEARCHING: 'A research-sized disagreement (2 to 7 points) on usable inputs.',
    MARKET_ALIGNED: 'EdgeDesk and the market are within 2 points.',
    INVESTIGATE: 'A 7+ point gap that has not passed the integrity checks.',
    MARKET_FAULT: 'A 7+ point gap the market is too thin or too stale to verify.',
    DATA_FAULT: 'An integrity check found a data problem; EdgeDesk’s number is unsafe until explained.',
    LIMITED_DATA: 'No projection, no current market, or inputs too thin to lean on.'
  };
  /* the canonical status's own rule, where one status has more than one
     cause (audit 2026-09-30): an INVESTIGATE is not always a 7+ point gap */
  var RESEARCH_RULE_MEANS = {
    regime_change: 'A disagreement on a programme in a regime change (a new head coach and a turned-over roster): held for checking until the team has played enough games for its number to describe this roster.',
    implausible_ev: 'A main-line price whose raw EV is too large to be plausible: a data error is the likelier explanation than an edge. Check the data first.',
    orientation_flip: 'A gap that nearly closes when one side’s sign is flipped: a possible home/away orientation error, excluded until the designation is confirmed.',
    market_fault_consensus: 'The market number the gap is measured against disagrees with the consensus of the quotes captured beside it.'
  };
  var BANNED = [/\block\b/i, /\bhammer/i, /max bet/i, /max play/i, /🔥/, /sharps?\s+(are|were|is|on|money|action|hit|side|play|loaded)/i, /sharp money/i, /smart money/i,
    /\bsteam\b/i, /syndicate/i, /guarantee/i, /can'?t lose/i, /sure thing/i, /free money/i, /the public is/i];

  /* ================================================================== ODDS
     A price is a line AND a price. Every price is normalised to American,
     decimal, the exact payout per unit and the break-even probability. A
     source that publishes an implied percentage keeps it: break-even is the
     source's own number and the American price is marked approximate. */
  function normalizePrice(x) {
    var D0 = dec(), a = null, d = null, p = null;
    if (isNum(x)) a = x;
    else if (x && typeof x === 'object') { a = num(x.american); d = num(x.decimal); p = num(x.implied); }
    else if (typeof x === 'string') return parsePrice(x);
    var out = { american: null, decimal: null, payout: null, break_even: null, implied_source: null, precision: null, approximate_american: false, valid: false, problem: null };
    if (isNum(a)) {
      if (a === 0 || (a > -100 && a < 100)) { out.problem = 'not an American price (' + a + ')'; return out; }
      if (Math.abs(a) > 20000) { out.problem = 'American price out of bounds (' + a + ')'; return out; }
      out.payout = D0.americanToPayout(a); out.american = a; out.precision = 'AMERICAN';
    } else if (isNum(d)) {
      if (!(d > 1.0001) || d > 201) { out.problem = 'decimal price out of bounds (' + d + ')'; return out; }
      out.payout = d - 1; out.american = D0.payoutToAmerican(out.payout); out.approximate_american = true; out.precision = 'DECIMAL';
    } else if (isNum(p)) {
      if (p > 1 && p < 100) p = p / 100;                    /* "53" means 53% */
      if (!(p > 0.005 && p < 0.995)) { out.problem = 'implied probability out of bounds (' + p + ')'; return out; }
      out.payout = (1 - p) / p; out.american = D0.payoutToAmerican(out.payout); out.approximate_american = true;
      out.implied_source = p; out.precision = 'IMPLIED_PERCENT';
    } else { out.problem = 'no price'; return out; }
    out.decimal = r(1 + out.payout, 6);
    out.break_even = out.precision === 'IMPLIED_PERCENT' ? out.implied_source : 1 / (1 + out.payout);
    out.valid = true;
    return out;
  }
  /* "-113", "+145", "1.91", "53%", "(−113)" */
  function parsePrice(s) {
    var t = String(s || '').replace(/[()\s]/g, '').replace(/[−–—]/g, '-');
    var m;
    if ((m = /^(\d+(?:\.\d+)?)%$/.exec(t))) return normalizePrice({ implied: parseFloat(m[1]) / 100 });
    if ((m = /^([+-]\d{3,5})$/.exec(t))) return normalizePrice(parseInt(m[1], 10));
    if ((m = /^(\d{3,5})$/.exec(t))) return normalizePrice(parseInt(m[1], 10));
    if ((m = /^(\d+\.\d+)$/.exec(t))) return normalizePrice({ decimal: parseFloat(m[1]) });
    return normalizePrice(null);
  }
  /* one expected-value formula: win × payout − loss; a push returns the stake */
  function evOf(win, push, payout) {
    if (!isNum(win) || !isNum(payout)) return null;
    var pu = isNum(push) ? push : 0, loss = 1 - win - pu;
    return win * payout - loss;
  }
  /* EV from a no-push cover probability: parity with decision.js expectedValue */
  function evFromCover(p, push, payout) {
    if (!isNum(p) || !isNum(payout)) return null;
    var pu = isNum(push) ? push : 0;
    return evOf(p * (1 - pu), pu, payout);
  }
  /* the American price at which a probability is exactly fair (no vig) */
  function fairAmerican(pWin, pLoss) {
    if (!isNum(pWin) || !isNum(pLoss) || pWin <= 0 || pLoss <= 0) return null;
    return dec().payoutToAmerican(pLoss / pWin);
  }
  function betterOrEqualPrice(pa, pb) { return isNum(pa) && isNum(pb) && pa >= pb - 1e-12; }       /* payouts */
  function nextBetterAmerican(a) { return a < 0 ? (a + 1 > -100 ? 101 : a + 1) : a + 1; }

  /* ============================================================ THE CURVE
     The build stores, for every half-point threshold t on the HOME MARGIN
     axis, P(margin > t) and P(margin = t) from the champion's distribution.
     Lines are always half points, so a read is an exact lookup — never an
     interpolation and never a model run. */
  function buildCurve(coverFn, center, halfWidth, meta) {
    meta = meta || {};
    if (typeof coverFn !== 'function' || !isNum(center)) return null;
    var c0 = Math.round(center * 2) / 2, hw = isNum(halfWidth) ? halfWidth : 30;
    var lo = c0 - hw, n = Math.round(4 * hw) + 1, win = [], push = [], i, t, c;     /* -hw .. +hw in half points */
    for (i = 0; i < n; i++) {
      t = lo + i * 0.5;
      c = coverFn(t);
      if (!c || !isNum(c.win)) return null;
      win.push(r(c.win, 6)); push.push(r(isNum(c.push) ? c.push : 0, 6));
    }
    return { axis: 'home_margin', lo: lo, step: 0.5, n: n, win: win, push: push,
      basis: meta.basis || null, conditioned_on_market_margin: isNum(meta.conditioned_on) ? meta.conditioned_on : null,
      model_version: meta.model_version || null, built_at: meta.built_at || null };
  }
  /* P(win / push / loss) for a side at its book line; null = outside the stored curve or not a half point */
  function sideProb(curve, side, line) {
    if (!curve || !curve.win || !isNum(line) || !halfPoint(line)) return null;
    var t = side === 'home' ? -line : line;
    var i = (t - curve.lo) / curve.step;
    if (Math.abs(i - Math.round(i)) > 1e-6) return null;
    i = Math.round(i);
    if (i < 0 || i >= curve.win.length) return null;
    var w = curve.win[i], p = curve.push[i] || 0, l = 1 - w - p;
    if (side === 'away') { var aw = l; l = w; w = aw; }
    w = clamp(w, 0, 1); l = clamp(l, 0, 1);
    return { win: w, push: p, loss: l, cover: (w + l) > 0 ? w / (w + l) : null };
  }
  /* P(the side's margin lands exactly on k) — the value of a key number in THIS game */
  function massAt(curve, side, k) {
    if (!curve || !isInt(k)) return null;
    var t = side === 'home' ? k : -k, i = Math.round((t - curve.lo) / curve.step);
    if (i < 0 || i >= curve.push.length) return null;
    return curve.push[i];
  }

  /* ====================================================== CALIBRATION
     The DECISION probability is the pure one after the validated
     calibration (decision.js decisionProbability): the map, then shrinkage
     toward the de-vigged market. Validated only for the model version the
     artifact names; otherwise CALIBRATION PENDING and nothing actionable.
     The uncertainty buffer is the artifact's own 95% interval on the model
     weight: the conservative probability is the smaller of the decision
     probabilities at the interval's two ends. */
  function calibrationOf(input) {
    var C = input.calibration || null;
    if (!C || C.status !== 'VALIDATED' || !C.cover_calibration) {
      return { status: 'PENDING', validated: false, version: C ? C.version || null : null, base_model_version: C ? C.base_model_version || null : null,
        reason: C && C.reason ? C.reason : 'no decision calibration is validated for this model' };
    }
    return { status: 'VALIDATED', validated: true, version: C.version || null, base_model_version: C.base_model_version || null,
      cover_calibration: C.cover_calibration, market_shrinkage: C.market_shrinkage || null,
      w_ci95: C.market_shrinkage && C.market_shrinkage.w_ci95 ? C.market_shrinkage.w_ci95 : null, reason: null };
  }
  function calibrate(cal, pRaw, marketP, feats) {
    if (!cal || !cal.validated || !isNum(pRaw)) return null;
    var D0 = dec(), A = { cover_calibration: cal.cover_calibration, market_shrinkage: cal.market_shrinkage };
    var mp = isNum(marketP) ? marketP : 0.5;
    var dp = D0.decisionProbability(pRaw, mp, feats || {}, A);
    var cons = dp.decision, ends = cal.w_ci95 && cal.market_shrinkage ? cal.w_ci95 : null;
    if (ends) {
      ends.forEach(function (w) {
        if (!isNum(w)) return;
        var sh = {}; for (var k in cal.market_shrinkage) if (has(cal.market_shrinkage, k)) sh[k] = cal.market_shrinkage[k];
        sh.w_model = clamp(w, 0, 1); delete sh.w_by; delete sh.by;
        var x = D0.decisionProbability(pRaw, mp, feats || {}, { cover_calibration: cal.cover_calibration, market_shrinkage: sh }).decision;
        if (isNum(x) && x < cons) cons = x;
      });
    }
    return { calibrated: dp.calibrated, decision: dp.decision, conservative: cons, w_model: dp.w_model, market_p: mp };
  }

  /* ========================================================= QUOTES
     Every quote the Read may price, in one shape. A quote carries both
     sides of one line from one book at one moment; an alternate may carry
     only one side. origin: LEDGER (captured by the Model Lab), STORED (a
     number an EdgeDesk artifact displayed), USER (typed by the reader). */
  function quoteAgeMinutes(q, now) {
    var o = ms(q.observed_at);
    if (o === null || now === null) return null;
    var u = ms(q.provider_updated_at), base = (u !== null && u < o) ? u : o;
    return (now - base) / 60000;
  }
  function freshnessOf(age, cfg) {
    if (!isNum(age)) return 'UNKNOWN';
    if (age < -5) return 'CLOCK_FAULT';
    if (age > cfg.stale_minutes) return 'STALE';
    if (age > cfg.stale_minutes / 2) return 'AGING';
    return 'FRESH';
  }
  function normalizeQuote(q, i) {
    q = q || {};
    var hl = num(q.home_line);
    if (!isNum(hl) && q.side && isNum(num(q.line))) hl = q.side === 'home' ? num(q.line) : -num(q.line);
    var out = { quote_id: q.quote_id != null ? String(q.quote_id) : ('q' + i), book: q.book || null, book_key: bookKey(q.book), source: q.source || null,
      origin: q.origin || 'LEDGER', alternate: !!q.alternate, market_type: q.market_type || 'spread', home_line: hl,
      price_home: q.price_home != null ? q.price_home : null, price_away: q.price_away != null ? q.price_away : null,
      implied_home: num(q.implied_home), implied_away: num(q.implied_away), decimal_home: num(q.decimal_home), decimal_away: num(q.decimal_away),
      observed_at: iso(q.observed_at), provider_updated_at: iso(q.provider_updated_at), pseudo: isPseudoBook(q.book) };
    return out;
  }
  function sidePriceOf(q, side) {
    var am = side === 'home' ? q.price_home : q.price_away, imp = side === 'home' ? q.implied_home : q.implied_away, de = side === 'home' ? q.decimal_home : q.decimal_away;
    if (am != null && am !== '') return normalizePrice(num(am));
    if (isNum(de)) return normalizePrice({ decimal: de });
    if (isNum(imp)) return normalizePrice({ implied: imp });
    return null;
  }

  /* ======================================================== CONSENSUS
     Not an average of everything on file: each real book counts once (its
     freshest quote, duplicate feeds of one book merged), stale quotes and
     robust outliers are excluded, a provider's own "consensus" is a
     reference only, and books are weighted equally because no book-quality
     weight has been validated (football/cfb_market/artifacts/book_quality_v1.json
     weights_active: false). */
  function consensusOf(quotes, now, cfg, integrity) {
    var main = quotes.filter(function (q) { return q.market_type === 'spread' && !q.alternate && q.origin !== 'USER' && isNum(q.home_line); });
    var latest = {}, excluded = [];
    main.forEach(function (q) {
      var k = q.pseudo ? 'pseudo:' + bookKey(q.source) : q.book_key;
      if (!latest[k] || ms(q.observed_at) > ms(latest[k].observed_at)) latest[k] = q;
    });
    /* duplicate feeds of one book (espn:draftkings and record:draftkings) are one book */
    var dupes = main.filter(function (q) { var k = q.pseudo ? 'pseudo:' + bookKey(q.source) : q.book_key; return latest[k] !== q && !q.pseudo; })
      .map(function (q) { return q.book + (q.source ? ' (' + q.source + ')' : ''); });
    var books = Object.keys(latest).map(function (k) { return latest[k]; });
    var real = books.filter(function (q) { return !q.pseudo; }), pseudo = books.filter(function (q) { return q.pseudo; });
    pseudo.forEach(function (q) { if (real.length) excluded.push({ book: q.book, source: q.source, home_line: q.home_line, reason: 'a provider’s own consensus is a reference, not a book' }); });
    var pool = real.length ? real : pseudo;
    var fresh = [];
    pool.forEach(function (q) {
      var age = quoteAgeMinutes(q, now);
      if (!isNum(age) || age > cfg.stale_minutes) excluded.push({ book: q.book, source: q.source, home_line: q.home_line, age_minutes: r(age, 0), reason: 'stale: older than ' + cfg.stale_minutes + ' min' });
      else fresh.push(q);
    });
    /* robust outliers: the Model Lab's own rule (integrity.assessMarket, MAD) when three or more books are fresh */
    var outlierIds = {};
    if (integrity && fresh.length >= 3) {
      try {
        var am = integrity.assessMarket(fresh.map(function (q) { return { source: q.source || 'book', book: q.book, market_type: 'spread', home_line: q.home_line,
          price_home: num(q.price_home), price_away: num(q.price_away), observed_at: q.observed_at, provider_updated_at: q.provider_updated_at, is_pregame: true, quote_id: q.quote_id }; }), iso(now), {});
        (am.outlier_quote_ids || []).forEach(function (id) { outlierIds[id] = 1; });
      } catch (e) { /* the screen is skipped, and said so below */ }
    }
    var used = fresh.filter(function (q) { if (outlierIds[q.quote_id]) { excluded.push({ book: q.book, source: q.source, home_line: q.home_line, reason: 'robust outlier against the other books (integrity MAD rule)' }); return false; } return true; });
    var out = { available: false, method: null, home_line: null, n_books: used.filter(function (q) { return !q.pseudo; }).length, books: [], excluded: excluded,
      duplicate_feeds_merged: dupes, stale: false, dispersion: null, as_of: null, price_home: null, price_away: null,
      weighting: 'equal weights: no book-quality weight is validated',
      outlier_screen: integrity ? (fresh.length >= 3 ? 'integrity MAD rule applied' : 'needs 3+ fresh books') : 'integrity rules not loaded' };
    var use = used.length ? used : pool;
    if (!use.length) { out.reason = 'no spread quote on file'; return out; }
    out.stale = !used.length;
    out.home_line = median(use.map(function (q) { return q.home_line; }));
    out.home_line = isNum(out.home_line) ? Math.round(out.home_line * 2) / 2 : null;
    out.method = real.length ? (use.length === 1 ? 'SINGLE_BOOK' : 'MEDIAN_OF_BOOKS') : 'PROVIDER_CONSENSUS';
    var ls = use.map(function (q) { return q.home_line; }).sort(function (a, b) { return a - b; });
    out.dispersion = ls.length > 1 ? r(ls[ls.length - 1] - ls[0], 2) : 0;
    out.as_of = iso(Math.max.apply(null, use.map(function (q) { return ms(q.observed_at); })));
    /* the consensus price: the median of the prices books charge AT the consensus number, when any do */
    var at = use.filter(function (q) { return Math.abs(q.home_line - out.home_line) < 1e-9; });
    var ph = median(at.map(function (q) { return num(q.price_home); })), pa = median(at.map(function (q) { return num(q.price_away); }));
    out.price_home = isNum(ph) ? Math.round(ph) : null; out.price_away = isNum(pa) ? Math.round(pa) : null;
    out.books = use.map(function (q) { return { book: q.book, source: q.source, home_line: q.home_line, price_home: num(q.price_home), price_away: num(q.price_away), observed_at: q.observed_at, age_minutes: r(quoteAgeMinutes(q, now), 0) }; });
    out.available = true;
    return out;
  }

  /* ================================================== QUOTE FRESHNESS
     Every quote with its book, source, capture time, true age, line and
     price. A STORED number (what an EdgeDesk artifact displayed) or a USER
     quote that disagrees with the newest capture by a point or more raises
     MARKET QUOTE CHECK; the newest valid quote is the one priced. */
  function freshnessAudit(quotes, stored, now, cfg) {
    var rows = quotes.map(function (q) {
      var age = quoteAgeMinutes(q, now);
      return { quote_id: q.quote_id, book: q.book, source: q.source, origin: q.origin, alternate: q.alternate, captured_at: q.observed_at,
        provider_updated_at: q.provider_updated_at, age_minutes: r(age, 0), status: freshnessOf(age, cfg),
        home_line: q.home_line, price_home: num(q.price_home), price_away: num(q.price_away) };
    });
    var newest = {};
    quotes.forEach(function (q) {
      if (q.origin === 'USER' || q.alternate || q.pseudo || !isNum(q.home_line)) return;
      if (!newest[q.book_key] || ms(q.observed_at) > ms(newest[q.book_key].observed_at)) newest[q.book_key] = q;
    });
    var checks = [];
    (stored || []).concat(quotes.filter(function (q) { return q.origin === 'USER'; })).forEach(function (s) {
      if (!isNum(num(s.home_line))) return;
      var k = bookKey(s.book), ref = k && newest[k] ? newest[k] : null;
      var pool = ref ? [ref] : Object.keys(newest).map(function (x) { return newest[x]; });
      pool.forEach(function (c) {
        var d = Math.abs(num(s.home_line) - c.home_line);
        if (d < cfg.quote_check_pts - 1e-9) return;
        var sAge = quoteAgeMinutes(s, now), cAge = quoteAgeMinutes(c, now);
        var sStale = !isNum(sAge) || sAge > cfg.stale_minutes, cStale = !isNum(cAge) || cAge > cfg.stale_minutes;
        var newer = ms(s.observed_at) != null && ms(s.observed_at) > ms(c.observed_at);
        var kind = s.origin === 'USER' ? 'USER_QUOTE_DIFFERS' : 'STORED_QUOTE_DIFFERS';
        var resolution = s.origin === 'USER'
          ? (cStale ? 'EdgeDesk’s last capture is stale: your quote is evaluated as a USER QUOTE and never enters the consensus.' : 'Both are recent: confirm the number at the book before acting. Your quote is evaluated as a USER QUOTE.')
          : (!cStale && (sStale || !newer) ? 'The stored number is replaced by the newer capture; EV is recomputed at ' + lineText(c.home_line) + '.'
            : (cStale && !sStale ? 'The capture is the stale one; nothing is actionable until a fresh quote confirms either number.' : 'Two current numbers disagree: nothing is actionable until one is confirmed.'));
        checks.push({ kind: kind, material: true, book: c.book, stored_home_line: num(s.home_line), stored_at: iso(s.observed_at), stored_label: s.label || s.source || s.origin,
          current_home_line: c.home_line, current_at: c.observed_at, difference_pts: r(d, 2), current_is_stale: cStale, stored_is_stale: sStale,
          blocks_action: s.origin === 'USER' ? false : !(!cStale && (sStale || !newer)), resolution: resolution });
      });
    });
    return { quotes: rows, checks: checks, quote_check: checks.length > 0,
      rule: 'a quote older than ' + cfg.stale_minutes + ' min is STALE (cfb_decision_policy_v1.stale_minutes); a stored or typed number ' + cfg.quote_check_pts + '+ pt off the newest capture of the same book raises MARKET QUOTE CHECK' };
  }

  /* ============================================================= OPTIONS
     One OPTION = one side at one line and one price from one quote. Every
     number of the Read is an option or a comparison of options. */
  function fairLineForSide(ctx, side) { return side === 'home' ? -ctx.fair_home_margin : ctx.fair_home_margin; }
  function teamOf(ctx, side) { return side === 'home' ? ctx.home : ctx.away; }
  function marketPOf(ctx, q, side, price) {
    /* the market's own probability for this side at this line: the two-sided
       de-vig when the book priced both sides; one-sided, the same book's
       main-line overround (proportional); otherwise the vig-inclusive
       break-even — conservative: it can only shrink an edge */
    var D0 = dec(), op = sidePriceOf(q, otherSide(side));
    if (price && price.valid && op && op.valid) {
      var s = price.break_even + op.break_even;
      if (s > 0.99 && s < 1.3) return { p: price.break_even / s, method: 'TWO_SIDED_DEVIG', overround: r(s - 1, 4) };
    }
    var ov = ctx.main_overround && isNum(ctx.main_overround[q.book_key]) ? ctx.main_overround[q.book_key] : null;
    if (price && price.valid && isNum(ov)) return { p: clamp(price.break_even / (1 + ov), 0.001, 0.999), method: 'MAIN_LINE_OVERROUND', overround: r(ov, 4) };
    if (price && price.valid) return { p: price.break_even, method: 'VIG_INCLUSIVE', overround: null };
    return { p: 0.5, method: 'REFERENCE_FAIR', overround: null };
    /* (D0 kept for symmetry with the other readers of decision.js) */
  }
  function evaluate(ctx, spec) {
    var cfg = ctx.cfg, side = spec.side, line = num(spec.line);
    var price = spec.price && spec.price.valid !== undefined ? spec.price : normalizePrice(spec.price);
    var q = spec.quote || { book: spec.book || null, book_key: bookKey(spec.book), source: spec.source || null, origin: spec.origin || 'HYPOTHETICAL',
      alternate: !!spec.alternate, observed_at: spec.observed_at || null, provider_updated_at: null, quote_id: spec.quote_id || null, price_home: null, price_away: null };
    var o = { side: side, team: teamOf(ctx, side), line: line, line_text: lineText(line), book: q.book, source: q.source, origin: q.origin || 'LEDGER',
      alternate: !!q.alternate, quote_id: q.quote_id || null, observed_at: q.observed_at || null,
      price: price ? { american: price.american, decimal: price.decimal, payout: r(price.payout, 6), break_even: r(price.break_even, 6), precision: price.precision, approximate_american: price.approximate_american } : null,
      label: teamOf(ctx, side) + ' ' + lineText(line) + (price && price.valid ? ' ' + priceText(price.american) + (price.approximate_american ? '*' : '') : ''),
      priced: !!(price && price.valid), problem: null };
    var age = q.observed_at ? quoteAgeMinutes(q, ctx.now) : null;
    o.age_minutes = r(age, 0);
    o.freshness = q.origin === 'HYPOTHETICAL' ? 'HYPOTHETICAL' : freshnessOf(age, cfg);
    o.fresh = o.freshness === 'FRESH' || o.freshness === 'AGING' || o.freshness === 'HYPOTHETICAL';
    if (!halfPoint(line)) { o.problem = 'the line ' + line + ' is not a half point: EdgeDesk prices half points only'; return o; }
    var p = sideProb(ctx.curve, side, line);
    if (!p) { o.problem = 'the line is outside the stored probability curve'; return o; }
    o.probability = { win: r(p.win), push: r(p.push), loss: r(p.loss), cover: r(p.cover), basis: 'raw' };
    o.fair_price = fairAmerican(p.win, p.loss);
    o.cushion = r(line - fairLineForSide(ctx, side), 2);
    if (!price || !price.valid) { o.problem = price ? price.problem : 'no price captured on this side'; o.raw_ev = null; return o; }
    o.break_even = r(price.break_even, 6);
    o.raw_cover = r(p.cover);
    o.raw_edge = r(p.cover - price.break_even);
    o.raw_ev = r(evOf(p.win, p.push, price.payout));
    var mk = marketPOf(ctx, q, side, price);
    o.market_probability = { value: r(mk.p), method: mk.method, overround: mk.overround };
    var cal = ctx.calibration;
    if (cal.validated) {
      var feats = { pure_cover_prob: p.cover, gap_pts: side === 'home' ? ctx.fair_home_margin - (ctx.market_margin || 0) : (ctx.market_margin || 0) - ctx.fair_home_margin,
        abs_line: Math.abs(line), is_home_side: side === 'home' ? 1 : 0 };
      feats.abs_gap_pts = Math.abs(feats.gap_pts);
      var c = calibrate(cal, p.cover, isNum(spec.market_p_override) ? spec.market_p_override : (spec.hypothetical_market_fair ? 0.5 : mk.p), feats);
      o.calibrated = { cover: r(c.calibrated), decision_cover: r(c.decision), conservative_cover: r(c.conservative), w_model: r(c.w_model, 3), market_p_used: r(c.market_p) };
      o.cover_used = r(c.decision); o.cover_basis = 'CALIBRATED';
      o.decision_ev = r(evFromCover(c.decision, p.push, price.payout));
      o.buffered_ev = r(evFromCover(c.conservative, p.push, price.payout));
      o.ev = o.decision_ev; o.ev_threshold = o.buffered_ev;
    } else {
      o.calibrated = null; o.cover_used = r(p.cover); o.cover_basis = 'RAW';
      o.decision_ev = null; o.buffered_ev = null; o.ev = o.raw_ev; o.ev_threshold = o.raw_ev;
    }
    o.edge = r(o.cover_used - price.break_even);
    var edgeOk = isNum(o.edge) && o.edge >= cfg.min_probability_edge - 1e-12, evOk = isNum(o.ev_threshold) && o.ev_threshold >= cfg.min_ev - 1e-12;
    o.clears = edgeOk && evOk;
    o.threshold = { edge_ok: edgeOk, ev_ok: evOk,
      text: o.clears ? 'clears: ' + pp(o.edge) + ' over break-even (needs ' + pp(cfg.min_probability_edge, 0) + ')' + (cal.validated ? ', EV after the uncertainty buffer ' + evText(o.ev_threshold) : '')
        : (!edgeOk ? pp(o.edge) + ' over break-even, under the ' + pp(cfg.min_probability_edge, 0) + ' threshold'
          : pp(o.edge) + ' over break-even, but EV after the uncertainty buffer is ' + evText(o.ev_threshold) + ' (the calibration’s 95% range on the model’s weight)') };
    o.ideal = o.clears && o.edge >= cfg.ideal_probability_edge - 1e-12;
    o.grade = o.clears ? 'VALUE' : (isNum(o.edge) && o.edge > 0 ? 'MARGINAL' : 'NO VALUE');
    o.within_price_limit = isNum(cfg.max_price) ? betterOrEqualPrice(price.payout, dec().americanToPayout(cfg.max_price)) : true;
    return o;
  }

  /* every option a set of quotes offers, both sides */
  function optionsOf(ctx, quotes) {
    var out = [];
    quotes.forEach(function (q) {
      if (q.market_type !== 'spread' || !isNum(q.home_line) || q.pseudo) return;
      ['home', 'away'].forEach(function (s) {
        var price = sidePriceOf(q, s);
        if (!price) return;                                           /* no price on this side: not an option */
        out.push(evaluate(ctx, { side: s, line: s === 'home' ? q.home_line : -q.home_line, price: price, quote: q }));
      });
    });
    return out;
  }
  /* only the newest quote per (book, line, alternate?) is a live option */
  function latestQuotes(quotes) {
    var by = {};
    quotes.forEach(function (q) {
      if (q.origin === 'USER') return;
      var k = q.book_key + '|' + (q.alternate ? 'alt:' + q.home_line : 'main');
      if (!by[k] || ms(q.observed_at) > ms(by[k].observed_at)) by[k] = q;
    });
    /* an alternate at the same number as the book's current main line is the main line */
    var mains = {};
    Object.keys(by).forEach(function (k) { if (/\|main$/.test(k)) mains[by[k].book_key] = by[k]; });
    return Object.keys(by).map(function (k) { return by[k]; }).filter(function (q) {
      return !(q.alternate && mains[q.book_key] && Math.abs(mains[q.book_key].home_line - q.home_line) < 1e-9);
    });
  }
  function rankEv(a, b) {
    var x = isNum(a.ev_threshold) ? a.ev_threshold : -9, y = isNum(b.ev_threshold) ? b.ev_threshold : -9;
    if (Math.abs(y - x) > 1e-12) return y - x;
    return (isNum(a.break_even) ? a.break_even : 1) - (isNum(b.break_even) ? b.break_even : 1);   /* ties: the cheaper protection */
  }

  /* ============================================= THRESHOLDS AND TARGETS
     BETTABLE TO: the worst number that still clears the same threshold the
     current price is judged by — at the reference price (a line), and at
     the current line (a price). TARGET: when the current number does not
     clear, the nearest better number that would. */
  function atReference(ctx, side, line) {
    return evaluate(ctx, { side: side, line: line, price: ctx.cfg.reference_price, hypothetical_market_fair: true });
  }
  function bettableTo(ctx, side, current) {
    var cfg = ctx.cfg, out = { side: side, reference_price: cfg.reference_price, line: null, price_at_current_line: null, preferred_line: null, pass_beyond: null, text: null };
    var start = current && isNum(current.line) ? current.line : fairLineForSide(ctx, side);
    if (!isNum(start)) return out;
    var c0 = Math.round(start * 2) / 2, found = null, pref = null, L, n;
    /* the edge only shrinks as the line worsens for the side, so walk down from well above */
    for (L = c0 + cfg.bettable_search_pts; L >= c0 - cfg.bettable_search_pts - 1e-9; L -= 0.5) {
      n = atReference(ctx, side, L);
      if (n.clears) { found = L; if (n.ideal) pref = L; }
      else if (found != null) break;
    }
    out.line = found; out.preferred_line = pref;
    out.pass_beyond = found != null ? found - 0.5 : null;
    /* the worst price at the current line */
    if (current && current.priced && isNum(current.cover_used)) {
      var pay = null, D0 = dec(), pc = current.cover_used, pu = current.probability.push;
      var beMax = pc - cfg.min_probability_edge;
      if (ctx.calibration.validated && current.calibrated) beMax = Math.min(beMax, current.calibrated.conservative_cover);
      if (beMax > 0 && beMax < 1) {
        pay = (1 - beMax) / beMax;
        var cand = D0.payoutToAmerican(pay), k;
        /* the market probability is held at the current quote's (decision.js minimumPrice holds p fixed) */
        var mp = current.market_probability ? current.market_probability.value : null, okc = false;
        for (k = 0; k < 8; k++) {
          var t = evaluate(ctx, { side: side, line: current.line, price: cand, market_p_override: mp,
            quote: { book: current.book, book_key: bookKey(current.book), source: current.source, origin: 'HYPOTHETICAL', price_home: null, price_away: null } });
          if (t.clears) { okc = true; break; }
          cand = nextBetterAmerican(cand);
        }
        out.price_at_current_line = okc ? cand : null;
      }
    }
    var team = teamOf(ctx, side), clearsNow = !!(current && current.clears);
    out.current_clears = clearsNow;
    out.label = !current ? 'CLEARS AT' : (clearsNow ? 'BETTABLE TO' : 'NEEDS');
    out.text = found == null ? 'No number within ' + cfg.bettable_search_pts + ' points clears the threshold at ' + priceText(cfg.reference_price) + '.'
      : !current ? team + ' ' + lineText(found) + ' ' + priceText(cfg.reference_price) + ' or better (no live price on file to compare)'
      : (clearsNow ? team + ' ' + lineText(found) + ' ' + priceText(cfg.reference_price) + ' equivalent' + (out.price_at_current_line != null ? ' · at ' + lineText(current.line) + ' down to ' + priceText(out.price_at_current_line) : '')
        : team + ' ' + lineText(found) + ' ' + priceText(cfg.reference_price) + ' or better' + (out.price_at_current_line != null && current ? ' · or ' + lineText(current.line) + ' at ' + priceText(out.price_at_current_line) + ' or better' : '') + ' (the current number does not clear)');
    return out;
  }

  /* ======================================================== ALTERNATES
     Buying points raises the chance of covering, and the book charges for
     it. The only question is whether the extra cover probability exceeds the
     extra break-even the price demands — plus the same uncertainty buffer
     every price must clear. A safer line is never better by being safer. */
  function keyCrossed(ctx, side, fromLine, toLine) {
    var lo = Math.min(fromLine, toLine), hi = Math.max(fromLine, toLine), out = [];
    /* the side's margins whose result changes: [-hi, -lo] */
    for (var k = Math.ceil(-hi - 1e-9); k <= Math.floor(-lo + 1e-9); k++) {
      var ak = Math.abs(k);
      if ((ctx.cfg.key_numbers || []).indexOf(ak) < 0) continue;
      out.push({ key: ak, game_mass: r(massAt(ctx.curve, side, k), 4), historical_share: ctx.key_mass && isNum(ctx.key_mass[ak]) ? ctx.key_mass[ak] : null,
        text: 'KEY NUMBER CROSSED: ' + ak + ' — EdgeDesk puts ' + pct(massAt(ctx.curve, side, k), 1) + ' of this game on exactly ' + ak
          + (ctx.key_mass && isNum(ctx.key_mass[ak]) ? '; ' + pct(ctx.key_mass[ak], 1) + ' of FBS games end there' : '') + '.' });
    }
    return out;
  }
  function compareOptions(ctx, a, b) {
    /* a = the reference (usually the main line), b = the alternative */
    if (!a || !b || !a.priced || !b.priced || a.side !== b.side || !isNum(a.cover_used) || !isNum(b.cover_used)) return null;
    var cfg = ctx.cfg;
    var dLine = b.line - a.line, dWin = b.probability.win - a.probability.win, dCover = b.cover_used - a.cover_used, dBe = b.break_even - a.break_even;
    var dEv = isNum(a.ev) && isNum(b.ev) ? b.ev - a.ev : null, dEvT = isNum(a.ev_threshold) && isNum(b.ev_threshold) ? b.ev_threshold - a.ev_threshold : null;
    /* juice cost in cents: + = the alternative charges more (-115 → -140 is +25) */
    var cents = isNum(a.price.american) && isNum(b.price.american) ? centsBetween(b.price.american, a.price.american) : null;
    var verdict, why;
    if (isNum(dEvT) && Math.abs(dEvT) < cfg.ev_equivalent) { verdict = 'EQUIVALENT'; why = 'The two prices are worth the same to within ' + (100 * cfg.ev_equivalent).toFixed(2) + '% of the stake.'; }
    else if (isNum(dEvT) && dEvT > 0) {
      verdict = b.clears ? (dLine > 0 ? 'BUY_WORTH_IT' : 'BETTER_PRICE') : 'BETTER_BUT_NOT_VALUE';
      why = dLine > 0 ? 'The extra ' + pts(dLine) + ' adds ' + ppAbs(dCover) + ' of cover probability for ' + ppAbs(dBe) + ' more break-even: the protection is priced below what EdgeDesk thinks it is worth.'
        : 'Giving up ' + pts(-dLine) + ' costs ' + ppAbs(dCover) + ' of cover probability but lowers break-even by ' + ppAbs(dBe) + ': the cheaper price is worth more.';
      if (!b.clears) why += ' Neither clears the threshold, so this is only the lesser of two passes.';
    } else {
      verdict = dLine > 0 ? 'TOO_EXPENSIVE' : 'WORSE_PRICE';
      why = dLine > 0 ? 'The extra ' + pts(dLine) + ' adds ' + ppAbs(dCover) + ' of cover probability but raises break-even by ' + ppAbs(dBe) + ': protection costs more than it is worth.'
        : (dLine < 0 ? 'The cheaper price gives up more cover probability (' + ppAbs(dCover) + ') than it saves in break-even (' + ppAbs(dBe) + ').'
          : 'Same number, worse price: ' + ppAbs(dBe) + ' more break-even for nothing.');
    }
    return { from: a.label, to: b.label, from_book: a.book, to_book: b.book, line_change: r(dLine, 2), win_probability_change: r(dWin), cover_probability_change: r(dCover),
      break_even_change: r(dBe), juice_cost_cents: cents, ev_change: r(dEv), ev_change_after_buffer: r(dEvT),
      incremental_value_pp: r(dCover - dBe), key_numbers_crossed: dLine !== 0 ? keyCrossed(ctx, a.side, a.line, b.line) : [],
      verdict: verdict, better: isNum(dEvT) ? (Math.abs(dEvT) < cfg.ev_equivalent ? 'EQUAL' : (dEvT > 0 ? 'B' : 'A')) : 'UNKNOWN', why: why,
      basis: a.cover_basis === 'CALIBRATED' ? 'calibrated decision probability, EV after the calibration’s uncertainty buffer' : 'raw model probability — calibration pending' };
  }
  function centsBetween(a, b) { var f = function (x) { return x < 0 ? x + 100 : x - 100; }; return f(b) - f(a); }
  function altLiquidity(q, mainQ, ctx) {
    var why = [];
    if (!q.alternate) return { level: 'MAIN', reasons: [] };
    if (q.price_home == null || q.price_away == null) why.push('one-sided: the book’s other side at this number was not captured');
    if (!mainQ) why.push('no main-line quote from the same book to cross-check');
    else if (ms(q.observed_at) < ms(mainQ.observed_at)) why.push('older than the same book’s main line (not refreshed with it)');
    var age = quoteAgeMinutes(q, ctx.now);
    if (!isNum(age) || age > ctx.cfg.stale_minutes / 2) why.push('aging quote (' + (isNum(age) ? Math.round(age) + ' min' : 'unknown age') + ')');
    return { level: why.length ? 'LOWER' : 'NORMAL', reasons: why };
  }
  function alternatesFor(ctx, sideOptions, quotesByBook) {
    var main = sideOptions.filter(function (o) { return !o.alternate && o.priced && o.fresh; }).sort(rankEv);
    var alts = sideOptions.filter(function (o) { return o.alternate && o.priced && o.fresh; });
    var mainBest = main[0] || null;
    var rows = alts.map(function (o) {
      var mq = quotesByBook[bookKey(o.book)] || null;
      var sameBookMain = main.filter(function (m) { return bookKey(m.book) === bookKey(o.book); })[0] || mainBest;
      var cmp = compareOptions(ctx, sameBookMain, o);
      var liq = altLiquidity(o._q || {}, mq, ctx);
      /* buying points that cost more than they add is a pass even when the alternate still clears on
         the main line's edge: that edge is already available without paying for the points */
      var tooDear = !!(cmp && cmp.verdict === 'TOO_EXPENSIVE');
      var verdict = tooDear ? 'TOO_EXPENSIVE' : (!o.clears ? 'PASS' : (cmp && cmp.better === 'B' ? 'BETTER_VALUE' : 'VALUE_BUT_MAIN_BETTER'));
      var text = tooDear ? 'PASS — protection costs too much' + (o.clears ? ' (it clears only on the main line’s edge, which is available without the extra juice)' : '')
        : (!o.clears ? 'PASS — the alternate does not clear the threshold'
        : (verdict === 'BETTER_VALUE' ? 'BETTER VALUE than the main line' : 'clears, but the main line is better value'));
      if (liq.level === 'LOWER') text += ' (lower confidence: ' + liq.reasons[0] + ')';
      return { option: o, vs_main: cmp, verdict: verdict, text: text, liquidity: liq };
    });
    var all = main.concat(alts);
    var clearing = all.filter(function (o) { return o.clears; });
    /* best value: the strongest expected value after the buffer among options that clear, fresh, and not thin */
    var trusted = clearing.filter(function (o) { if (!o.alternate) return true; var row = rows.filter(function (x) { return x.option === o; })[0]; return !row || row.liquidity.level !== 'LOWER'; });
    var bestValue = trusted.slice().sort(rankEv)[0] || null;
    var bestAlt = rows.slice().sort(function (x, y) { return rankEv(x.option, y.option); })[0] || null;
    var safest = rows.slice().sort(function (x, y) { return (y.option.probability.win - x.option.probability.win) || rankEv(x.option, y.option); })[0] || null;
    return {
      main_line: mainBest, best_alt: bestAlt ? bestAlt.option : null, best_alt_row: bestAlt, safest_alt: safest ? safest.option : null,
      best_value: bestValue, best_value_is_alternate: !!(bestValue && bestValue.alternate), rows: rows,
      overpriced: rows.filter(function (x) { return x.vs_main && x.vs_main.verdict === 'TOO_EXPENSIVE'; }).map(function (x) { return { label: x.option.label, book: x.option.book, why: x.vs_main.why, ev_change: x.vs_main.ev_change_after_buffer }; }),
      captured: alts.length,
      note: alts.length ? 'Safest is the alternate with the highest chance of winning. It is never the preferred line for being safer: best value is decided by expected value after the uncertainty buffer.'
        : 'No alternate spread was captured for this game. EdgeDesk prices any alternate you enter below with the same distribution.'
    };
  }

  /* ======================================================= PRICE CURVE
     The side's price curve: every captured quote at its own line and price,
     plus the reference ladder (the policy's reference price at each half
     point — a reference, not an offer). */
  function priceCurve(ctx, side, sideOptions, bestValue, center) {
    var cfg = ctx.cfg, rows = [];
    sideOptions.filter(function (o) { return o.priced; }).forEach(function (o) {
      rows.push({ kind: o.alternate ? 'ALTERNATE' : 'MAIN', book: o.book, line: o.line, line_text: o.line_text, price: o.price.american, approximate_price: o.price.approximate_american,
        break_even: o.break_even, cover: o.cover_used, raw_cover: o.raw_cover, push: o.probability.push, win: o.probability.win, ev: o.ev, ev_after_buffer: o.ev_threshold,
        edge: o.edge, fresh: o.fresh, freshness: o.freshness,
        read: o === bestValue ? 'BEST VALUE' : (o.clears ? 'VALUE' : (o.grade === 'MARGINAL' ? 'MARGINAL' : 'PASS')) });
    });
    var ladder = [];
    if (isNum(center)) {
      var c0 = Math.round(center * 2) / 2;
      for (var k = -cfg.ladder_half_points; k <= cfg.ladder_half_points; k++) {
        var L = c0 + k * 0.5, n = atReference(ctx, side, L);
        if (!n.priced || n.problem) continue;
        ladder.push({ kind: 'REFERENCE', line: L, line_text: lineText(L), price: cfg.reference_price, break_even: n.break_even, cover: n.cover_used, raw_cover: n.raw_cover,
          push: n.probability.push, win: n.probability.win, ev: n.ev, ev_after_buffer: n.ev_threshold, edge: n.edge, read: n.clears ? (n.ideal ? 'VALUE (IDEAL)' : 'VALUE') : (n.grade === 'MARGINAL' ? 'MARGINAL' : 'PASS') });
      }
    }
    rows.sort(function (x, y) { return (y.line - x.line) || ((x.price || 0) - (y.price || 0)); });
    ladder.sort(function (x, y) { return y.line - x.line; });
    return { side: side, team: teamOf(ctx, side), offered: rows, ladder: ladder, reference_price: cfg.reference_price,
      note: 'Offered rows are captured quotes at their own price. Ladder rows are the reference price (' + priceText(cfg.reference_price) + ') at every half point — a reference, not an offer.' };
  }
  /* the alternate price frontier: protection on x, break-even / cover / EV on y */
  function frontier(ctx, side, sideOptions, ladderRows) {
    var pts2 = [];
    ladderRows.forEach(function (x) { pts2.push({ kind: 'REFERENCE', line: x.line, cover: x.cover, break_even: x.break_even, ev: x.ev }); });
    sideOptions.filter(function (o) { return o.priced && o.fresh; }).forEach(function (o) {
      pts2.push({ kind: o.alternate ? 'ALTERNATE' : 'MAIN', book: o.book, line: o.line, price: o.price.american, cover: o.cover_used, break_even: o.break_even, ev: o.ev, ev_after_buffer: o.ev_threshold });
    });
    pts2.sort(function (a, b) { return a.line - b.line; });
    /* where buying points stops being efficient: the offered point past which EV falls */
    var offered = pts2.filter(function (x) { return x.kind !== 'REFERENCE' && isNum(x.ev_after_buffer); });
    var peak = offered.slice().sort(function (a, b) { return b.ev_after_buffer - a.ev_after_buffer; })[0] || null;
    return { side: side, points: pts2, efficient_to: peak ? { line: peak.line, price: peak.price, book: peak.book } : null,
      text: peak ? 'Among the prices offered, value peaks at ' + teamOf(ctx, side) + ' ' + lineText(peak.line) + ' ' + priceText(peak.price) + (peak.book ? ' (' + peak.book + ')' : '') + '; buying further costs more than the points are worth.' : null };
  }

  /* ================================================ MARKET MOVEMENT
     Factual only: where the market opened, where it is, where the best and
     the selected number are, and whether the move was toward EdgeDesk. It
     is informative, never proof, and never called anything but movement. */
  function movementOf(ctx, cons, open, sideCur) {
    var cfg = ctx.cfg, out = { open: null, consensus: null, best_available: sideCur.best || null, selected: sideCur.selected || null,
      movement_pts: null, direction: 'UNKNOWN', text: null };
    if (open && isNum(num(open.home_line))) out.open = { home_line: num(open.home_line), at: iso(open.observed_at || open.at), source: open.source || null };
    if (cons && cons.available) out.consensus = { home_line: cons.home_line, n_books: cons.n_books, as_of: cons.as_of, stale: cons.stale };
    if (!out.open || !out.consensus) { out.text = out.open ? 'No current consensus to compare with the open.' : 'No opener was captured, so the market’s direction is unknown.'; return out; }
    var mOpen = -out.open.home_line, mNow = -out.consensus.home_line, fair = ctx.fair_home_margin;
    var mv = mNow - mOpen;                                     /* + = the market moved toward HOME */
    out.movement_pts = r(Math.abs(mv), 2);
    out.moved_toward_team = mv > 0 ? ctx.home : (mv < 0 ? ctx.away : null);
    if (Math.abs(mv) < cfg.move_pts - 1e-9) { out.direction = 'STABLE'; out.text = 'MARKET STABLE: within ' + cfg.move_pts + ' pts of its ' + (out.open.source && /first capture/.test(out.open.source) ? 'first capture' : 'open') + ' (' + ctx.home + ' ' + lineText(out.open.home_line) + ' → ' + lineText(out.consensus.home_line) + ').'; return out; }
    var toward = (fair - mOpen) !== 0 && Math.sign(mv) === Math.sign(fair - mOpen);
    out.direction = toward ? 'TOWARD' : 'AWAY';
    out.text = 'MARKET MOVED ' + Math.abs(mv).toFixed(1) + ' ' + (Math.abs(Math.abs(mv) - 1) < 1e-9 ? 'POINT' : 'POINTS') + ' ' + (toward ? 'TOWARD' : 'AWAY FROM') + ' EDGEDESK ('
      + ctx.home + ' ' + lineText(out.open.home_line) + ' → ' + lineText(out.consensus.home_line) + (out.open.source && /first capture/.test(out.open.source) ? ' since the ' + out.open.source : ' since the open') + '; EdgeDesk ' + ctx.home + ' ' + lineText(-fair) + '). Movement is informative, not proof.';
    return out;
  }

  /* ========================================================= PRICE GONE
     The football opinion can stay while the number that made it value
     leaves. The first number and the current one are judged by the SAME
     current EdgeDesk distribution, so only the price has changed. */
  function priceGoneOf(ctx, side, initial, current) {
    var out = { state: 'UNKNOWN', text: null, initial: null, current: null };
    if (!initial || !current) { out.text = initial ? 'No current price on EdgeDesk’s side.' : 'No first number on file for this side.'; return out; }
    out.initial = { line: initial.line, price: initial.price ? initial.price.american : null, at: initial.observed_at, edge: initial.edge, clears: initial.clears, label: initial.label };
    out.current = { line: current.line, price: current.price ? current.price.american : null, edge: current.edge, clears: current.clears, label: current.label };
    if (!initial.clears) { out.state = 'NO_INITIAL_VALUE'; out.text = 'The first number (' + initial.label + ') did not clear the threshold either: there was no price to lose.'; return out; }
    if (!current.clears) { out.state = 'GONE'; out.text = 'PRICE GONE: ' + initial.label + ' cleared the threshold (' + pp(initial.edge) + '); ' + current.label + ' does not (' + pp(current.edge) + '). The football opinion is unchanged; the number is not.'; return out; }
    var ratio = isNum(initial.edge) && initial.edge > 0 ? current.edge / initial.edge : null;
    out.retained_share = r(ratio, 3);
    out.state = !isNum(ratio) ? 'UNKNOWN' : (ratio <= ctx.cfg.decay_most_gone ? 'MOSTLY_GONE' : (ratio <= ctx.cfg.decay_partial ? 'PARTIAL' : 'INTACT'));
    out.text = { MOSTLY_GONE: 'PRICE MOSTLY GONE: the edge fell from ' + pp(initial.edge) + ' at ' + initial.label + ' to ' + pp(current.edge) + ' now. It still clears, barely.',
      PARTIAL: 'Part of the price is gone: ' + pp(initial.edge) + ' at ' + initial.label + ' → ' + pp(current.edge) + ' now.',
      INTACT: 'The price is intact: ' + pp(initial.edge) + ' at ' + initial.label + ' → ' + pp(current.edge) + ' now.', UNKNOWN: null }[out.state];
    return out;
  }

  /* ===================================================== RESEARCH GATE
     Research status is not decision status. A verified major disagreement
     can still be a PASS; an unverified one can never be actionable. */
  /* THE READ'S RESEARCH STATUS IS THE CANONICAL ONE (audit 2026-09-30 #6).
     Every Read input is built from a terminal object (fromTerminal), which
     carries lib/edgedesk_canon.js researchStatusOfTerminal; that status is
     named here in the Read's vocabulary and never re-derived. The rule below
     it survives only for an input that carries no canonical status (a
     hand-built fixture), and says so in its reason. */
  var CANON_TO_READ = { VERIFIED_MAJOR: 'VERIFIED_MAJOR_DISAGREEMENT', WORTH_RESEARCHING: 'WORTH_RESEARCHING', INVESTIGATE: 'INVESTIGATE',
    MARKET_FAULT: 'MARKET_FAULT', DATA_FAULT: 'DATA_FAULT', NEAR_PICKEM: 'MARKET_ALIGNED', MARKET_ALIGNED: 'MARKET_ALIGNED',
    LIMITED_DATA: 'LIMITED_DATA', NO_MARKET: 'LIMITED_DATA' };
  function researchOf(input, cfg) {
    var R = input.research || {}, C = R.disagreement || {};
    var key, why;
    if (R.canonical && CANON_TO_READ[R.canonical.key]) { key = CANON_TO_READ[R.canonical.key]; why = R.canonical.reason || RESEARCH_STATUS[key]; }
    else if (R.fault || R.status_key === 'DATA_FAULT' || C.verification === 'DATA_FAULT') { key = 'DATA_FAULT'; why = R.reason || 'an integrity check found a data problem'; }
    else if (!input.model || !input.model.available) { key = 'LIMITED_DATA'; why = 'no EdgeDesk projection for this game'; }
    else if (C.verification === 'MARKET_FAULT') { key = 'MARKET_FAULT'; why = R.reason || 'the market cannot verify a 7+ point gap'; }
    else if (C.class === 'MAJOR' && C.verified) { key = 'VERIFIED_MAJOR_DISAGREEMENT'; why = 'the 7+ point gap passed every integrity check'; }
    else if (C.class === 'MAJOR' || R.status_key === 'INVESTIGATE') { key = 'INVESTIGATE'; why = R.reason || 'a 7+ point gap that has not passed the integrity checks'; }
    else if (R.status_key === 'NO_MARKET') { key = 'LIMITED_DATA'; why = R.reason || 'no current market'; }
    else if (R.limited) { key = 'LIMITED_DATA'; why = R.limited; }
    else if (C.class === 'MODERATE') { key = 'WORTH_RESEARCHING'; why = 'a ' + (isNum(C.points) ? C.points.toFixed(1) : '') + '-point disagreement'; }
    else { key = 'MARKET_ALIGNED'; why = 'EdgeDesk and the market are within ' + cfg.research_gap + ' points'; }
    var gate = key === 'DATA_FAULT' ? 'DATA_FAULT' : (key === 'INVESTIGATE' || key === 'MARKET_FAULT' ? 'INVESTIGATE' : (key === 'VERIFIED_MAJOR_DISAGREEMENT' ? 'VERIFIED' : 'NOT_REQUIRED'));
    var rule = R.canonical && R.canonical.rule ? R.canonical.rule : null;
    return { status: key, label: key.replace(/_/g, ' '), means: (rule && RESEARCH_RULE_MEANS[rule]) || RESEARCH_STATUS[key], reason: why, rule: rule, terminal_status: R.status_key || null,
      integrity_gate: gate, blocks_action: gate === 'DATA_FAULT' || gate === 'INVESTIGATE', caps_at_research: key === 'LIMITED_DATA',
      verified: key === 'VERIFIED_MAJOR_DISAGREEMENT' };
  }

  /* ============================================================ TIMING
     Deterministic, first rule that holds. It never forecasts a line and
     never waits "for sharps". BET and BET EARLY exist only on the governed
     engine's BET for that exact quote; everything else is research. */
  function qbState(input) {
    var q = (input.context && input.context.qb) || {}, out = { unresolved: [], unconfirmed: [], resolved: true };
    ['home', 'away'].forEach(function (s) {
      var x = q[s], team = s === 'home' ? input.game.home : input.game.away;
      if (!x) { out.unresolved.push(team + ': no starter identified'); return; }
      if (x.contested) out.unresolved.push(team + ': contested quarterback job' + (x.label ? ' (' + x.label + ')' : ''));
      else if (!x.confirmed) out.unconfirmed.push(team + ': ' + (x.player || 'the starter') + ' expected, not confirmed');
    });
    out.resolved = !out.unresolved.length;
    return out;
  }
  function urgencyOf(ctx, side, cur, bt, mv) {
    var why = [];
    if (mv && mv.direction === 'TOWARD') why.push({ code: 'MARKET_TOWARD', text: mv.text });
    /* the next half point worse for the side crosses a primary key number */
    var worse = cur.line - 0.5, kc = keyCrossed(ctx, side, worse, cur.line);
    if (kc.length) why.push({ code: 'KEY_NUMBER_AT_RISK', text: 'Losing half a point from ' + lineText(cur.line) + ' crosses ' + kc[0].key + ' (' + pct(kc[0].game_mass, 1) + ' of this game lands exactly there).' });
    var support = [];
    if (bt && isNum(bt.line) && cur.line - bt.line >= 1 - 1e-9) support.push({ code: 'CUSHION', text: 'The current number is ' + pts(cur.line - bt.line) + ' better than the bettable-to number (' + lineText(bt.line) + ').' });
    return { reasons: why, support: support };
  }
  function timingOf(ctx, input, research, side, cur, bt, pg, mv, qb, altSummary, cons) {
    var cfg = ctx.cfg, G = input.governed || {}, blockers = [];
    function res(key, code, text, extra) { var o = { timing_read: key, decision_status: DECISION_OF_TIMING[key], reason_code: code, reason: text, means: TIMING[key] }; if (extra) for (var k in extra) o[k] = extra[k]; return o; }
    if (!input.model || !input.model.available) return res('NO_DECISION', 'NO_MODEL', 'No EdgeDesk projection for this game.');
    if (!ctx.curve) return res('NO_DECISION', 'NO_CURVE', 'The probability curve is missing: nothing can be priced.');
    if (research.integrity_gate === 'DATA_FAULT') return res('INVESTIGATE', 'DATA_FAULT', 'DATA FAULT: ' + stop(research.reason) + '.');
    if (research.blocks_action) return res('INVESTIGATE', research.status, research.label + ': ' + stop(research.reason) + '. Not priced as actionable until verified.');
    if (ctx.quote_check_blocks) return res('INVESTIGATE', 'MARKET_QUOTE_CHECK', 'MARKET QUOTE CHECK: two current numbers for the same book disagree by a point or more. Nothing is actionable until one is confirmed.');
    if (!cons || !cons.available) return res('NO_DECISION', 'NO_MARKET', 'No market quote on file.');
    if (!side) return res('PASS', 'MARKET_ALIGNED', 'EdgeDesk matches the market: there is no side to take.');
    if (!cur) {
      if (ctx.all_stale) return res('NO_DECISION', 'STALE_MARKET', 'STALE MARKET: every quote on EdgeDesk’s side is older than ' + cfg.stale_minutes + ' minutes. Nothing is priced off a quote that may no longer exist.');
      return res('NO_DECISION', 'NO_PRICE', 'No priced quote on ' + teamOf(ctx, side) + '’s side in this view.');
    }
    /* the current price clears */
    if (cur.clears && !ctx.calibration.validated && isNum(ctx.gap_pts) && ctx.gap_pts < cfg.research_gap && !(isNum(ctx.book_edge_pts) && ctx.book_edge_pts >= cfg.book_edge_pts)) {
      /* an uncalibrated probability never turns a small gap into value: the raw margin distribution is lumpy
         around key numbers, and no calibration says how far to trust it (a calibrated read decides on its own) */
      return res('PASS', 'SMALL_GAP_RAW', 'PASS — EdgeDesk and the market are ' + pts(ctx.gap_pts) + ' apart, inside the ' + cfg.research_gap + '-point research threshold. The raw cover probability at '
        + cur.label + ' (' + pct(cur.cover_used, 1) + ') is not calibrated, so a small gap is not read as value.');
    }
    if (cur.clears) {
      if (!qb.resolved) return res('WAIT', 'QB_UNRESOLVED', 'WAIT — information pending: ' + stop(qb.unresolved.join('; ')) + '. The price clears (' + pp(cur.edge) + ' at ' + cur.label + '), but the thesis depends on who starts.');
      var gd = cur.quote_id && G.by_quote ? G.by_quote[cur.quote_id] : null;
      var certified = !!(gd && gd.status === 'BET') && ctx.calibration.validated && cur.origin === 'LEDGER' && cur.fresh;
      if (!certified) {
        var why = !ctx.calibration.validated ? 'CALIBRATION PENDING: ' + stop(ctx.calibration.reason)
          : (gd ? 'the governed decision engine says ' + gd.status + (gd.reason_codes && gd.reason_codes.length ? ' (' + gd.reason_codes.join(', ') + ')' : '') : (cur.origin === 'USER' ? 'a USER QUOTE is never certified' : 'no governed decision for this quote'));
        if (ctx.calibration.validated && cons.n_books < cfg.min_books && (!gd || (gd.reason_codes || []).indexOf('RESEARCH_MARKET_IMMATURE') >= 0))
          return res('WAIT', 'MARKET_IMMATURE', 'WAIT — the market is thin: ' + cons.n_books + ' book' + (cons.n_books === 1 ? '' : 's') + ' (a consensus needs ' + cfg.min_books + '). The price clears, but one book is a quote, not a market.');
        return res('RESEARCH', 'NOT_CERTIFIED', 'RESEARCH ONLY — the price clears EdgeDesk’s threshold (' + pp(cur.edge) + ' at ' + cur.label + '), but it is not a certified bet: ' + why + '.');
      }
      if (research.caps_at_research) return res('RESEARCH', 'LIMITED_DATA', 'RESEARCH ONLY — the price clears, but the inputs are too limited for an actionable read: ' + stop(research.reason) + '.');
      if (!cur.within_price_limit) return res('RESEARCH', 'PRICE_LIMIT', 'RESEARCH ONLY — the price is outside the policy’s ' + priceText(cfg.max_price) + ' limit.');
      var U = urgencyOf(ctx, side, cur, bt, ctx.movement);
      if (U.reasons.length) return res('BET_EARLY', 'BET_EARLY', 'BET EARLY — ' + U.reasons.map(function (x) { return x.text; }).join(' '), { urgency: U });
      return res('BET', 'CERTIFIED', 'The governed decision engine certified ' + cur.label + '. No measured reason to hurry.', { urgency: U });
    }
    /* the current price does not clear */
    if (pg && pg.state === 'GONE') return res('PRICE_GONE', 'PRICE_GONE', pg.text);
    var gap = ctx.gap_pts;
    /* the number is fine, the juice is not: the same line at the policy's reference price clears. The
       reference price is the market's standard (93.8% of archived openers were -110 both ways,
       docs/cfb-decision/DESIGN.md), so the target is this number at the price that clears */
    if (isNum(gap) && gap >= cfg.research_gap && bt && isNum(bt.line) && bt.line <= cur.line && isNum(bt.price_at_current_line)
        && dec().americanToPayout(bt.price_at_current_line) <= dec().americanToPayout(cfg.reference_price) + 1e-12) {
      return res('PRICE_TARGET', 'TARGET_PRICE', 'WAIT FOR A PRICE — ' + cur.label + ' does not clear (' + cur.threshold.text + '). The number is good; the juice is not: '
        + teamOf(ctx, side) + ' ' + lineText(cur.line) + ' at ' + priceText(bt.price_at_current_line) + ' or better would clear, no better than the standard ' + priceText(cfg.reference_price) + '. Not a forecast that it appears.',
        { target: { line: cur.line, price: bt.price_at_current_line, distance_pts: 0, kind: 'PRICE' } });
    }
    if (isNum(gap) && gap >= cfg.research_gap && bt && isNum(bt.line) && bt.line > cur.line) {
      var dist = bt.line - cur.line;
      if (dist <= cfg.typical_move_pts + 1e-9) return res('PRICE_TARGET', 'TARGET', 'WAIT FOR A NUMBER — ' + cur.label + ' does not clear (' + cur.threshold.text + '). ' + teamOf(ctx, side) + ' ' + lineText(bt.line) + ' ' + priceText(cfg.reference_price) + ' or better would, ' + pts(dist) + ' away — inside ordinary open-to-close movement (' + cfg.typical_move_pts + ' pts). Not a forecast that it arrives.',
        { target: { line: bt.line, price: cfg.reference_price, distance_pts: r(dist, 2), kind: 'LINE' } });
      return res('PASS', 'TARGET_OUT_OF_REACH', 'PASS — ' + cur.label + ' does not clear (' + cur.threshold.text + '), and the first number that would (' + lineText(bt.line) + ') is ' + pts(dist) + ' away, beyond ordinary movement (' + cfg.typical_move_pts + ' pts).');
    }
    if (isNum(gap) && gap < cfg.research_gap) return res('PASS', 'SMALL_GAP', 'PASS — EdgeDesk and the market are ' + pts(gap) + ' apart, inside the ' + cfg.research_gap + '-point research threshold.');
    return res('PASS', 'PRICE', 'PASS — at ' + cur.label + ' EdgeDesk’s cover probability (' + pct(cur.cover_used, 1) + ') against break-even (' + pct(cur.break_even, 1) + '): ' + cur.threshold.text + '. Not enough margin for model error.');
  }

  /* ====================================================== EXPLANATIONS */
  function whyDiffers(input) {
    var W = (input.context && input.context.why) || null;
    if (!W || !W.available) return { available: false, rows: [], text: W && W.reason ? W.reason : 'The champion’s term-by-term contributions were not published with this build.' };
    return { available: true, partial: !!W.partial, rows: (W.rows || []).map(function (x) { return { label: x.label, points: x.points, favors: x.favors, text: x.text }; }),
      final_fair: W.fair_text || null, reconciles: W.reconciles, market_implied: W.market_implied ? W.market_implied.text : null, basis: W.basis || null,
      unpriced: W.unpriced || [], note: 'The champion’s own additive terms. They sum to the fair line; nothing here is a narrative.' };
  }
  function riskOf(input, ctx, research, qb, cur) {
    var X = input.context || {}, out = [];
    function add(code, sev, text, source) { out.push({ code: code, severity: sev, text: text, source: source }); }
    qb.unresolved.forEach(function (t) { add('QB_UNRESOLVED', 'high', t, 'starter context'); });
    qb.unconfirmed.forEach(function (t) { add('QB_UNCONFIRMED', 'moderate', t, 'starter context'); });
    ((X.risks && X.risks.items) || []).forEach(function (x) { if (!/^qb_/.test(x.key || '')) add(String(x.key || 'RISK').toUpperCase(), x.severity || 'moderate', x.text, 'research object risks'); });
    var ag = X.agreement;
    if (ag && ag.available && ag.agreement && ag.agreement.tier && ag.agreement.tier !== 'HIGH') add('MODEL_DISAGREEMENT', ag.agreement.tier === 'LOW' ? 'high' : 'moderate', 'EdgeDesk’s own models disagree (SD ' + (isNum(ag.sd) ? ag.sd.toFixed(1) : '—') + ' pts, ' + ag.agreement.tier + ' agreement).', 'model consensus');
    if (X.reconcile && X.reconcile.available && X.reconcile.rows && X.reconcile.rows.length) {
      var top = X.reconcile.rows[0];
      add('WHAT_WOULD_HAVE_TO_BE_WRONG', 'context', top.text + (isNum(top.sds_needed) ? ' (' + top.sds_needed.toFixed(1) + ' of its own SDs)' : ''), 'reconciliation');
    }
    if (isNum(X.expected_abs_error) && cur && isNum(cur.cushion)) add('TYPICAL_MISS', 'context', 'EdgeDesk’s typical miss is ' + X.expected_abs_error.toFixed(1) + ' pts; the cushion at ' + cur.label + ' is ' + (cur.cushion >= 0 ? '+' : '−') + Math.abs(cur.cushion).toFixed(1) + ' pts.', 'error model');
    if (research.status === 'INVESTIGATE' || research.status === 'MARKET_FAULT') add('UNVERIFIED_GAP', 'high', research.reason, 'integrity gate');
    if (!ctx.calibration.validated) add('CALIBRATION_PENDING', 'high', 'The cover probability is the raw model’s; no decision calibration is validated for ' + (input.model && input.model.model_version) + '. The only calibration on file shows a model’s raw cover probability is overconfident against the market.', 'decision calibration');
    var seen = {};
    return out.filter(function (x) { var k = x.code + '|' + x.text; if (seen[k]) return false; seen[k] = 1; return true; });
  }
  function agreementOf(input) {
    var K = input.context && input.context.agreement;
    if (!K || !K.available) return { available: false, label: 'UNKNOWN', text: 'Fewer than two independent model numbers exist for this game.' };
    var map = { HIGH: 'STRONG', MODERATE: 'MODERATE', LOW: 'WEAK' };
    return { available: true, label: map[K.agreement.tier] || 'UNKNOWN', tier: K.agreement.tier, sd: K.sd, score: K.agreement.score, n_independent: K.n_independent,
      side_support: K.side_support ? K.side_support.text : null, basis: K.agreement.basis, components: (K.rows || []).map(function (x) { return { label: x.label, text: x.text, home_margin: x.home_margin, independent: x.independent, vs_market: x.vs_market }; }),
      why_disagree: K.why_disagree || [] };
  }

  /* ===================================================== MARKETS BEYOND THE SPREAD
     Built for totals, team totals and moneylines, activated only where a
     validated calibration exists (football/validation/pricing_cfb.json).
     Today every CFB market is tier RESEARCH, so they are shown, labelled,
     and never decided on. */
  function moneylineOf(input, cfg) {
    var M = input.market && input.market.moneyline, m = input.model || {};
    var out = { status: 'NOT_ACTIVATED', reason: 'moneyline is tier RESEARCH in football/validation/pricing_cfb.json: the win probability is not validated for wagering', available: false };
    if (!isNum(m.home_win_prob)) return out;
    var ph = m.home_win_prob;
    out.fair = { home: dec().payoutToAmerican((1 - ph) / ph), away: dec().payoutToAmerican(ph / (1 - ph)), home_win_prob: r(ph), source: 'champion win probability' };
    if (M && isNum(num(M.price_home)) && isNum(num(M.price_away))) {
      var dv = dec().devig(num(M.price_home), num(M.price_away));
      out.book = { book: M.book || null, price_home: num(M.price_home), price_away: num(M.price_away), observed_at: M.observed_at || null,
        implied_home: r(dec().breakEven(num(M.price_home))), no_vig_home: dv ? r(dv.p_a) : null, hold: dv ? r(dv.hold) : null };
      out.research_ev = { home: r(evOf(ph, 0, dec().americanToPayout(num(M.price_home)))), away: r(evOf(1 - ph, 0, dec().americanToPayout(num(M.price_away)))),
        note: 'research only: the win probability is not calibrated for wagering' };
    }
    out.available = true;
    return out;
  }

  /* ================================================================ THE READ */
  function read(input, over) {
    input = input || {};
    var cfg = config(over || input.config);
    var now = ms(input.now); if (now === null) now = Date.now();
    var g = input.game || {}, m = input.model || {};
    var view = input.view || { mode: 'best' };
    var cal = calibrationOf(input);
    var ctx = { cfg: cfg, now: now, curve: input.curve || null, calibration: cal, home: g.home, away: g.away,
      fair_home_margin: num(m.home_margin), key_mass: (input.context && input.context.key_mass) || null, main_overround: {} };
    var quotes = ((input.market && input.market.quotes) || []).map(normalizeQuote)
      .concat(((input.user_quotes) || []).map(function (q, i) { var x = normalizeQuote(q, 'u' + i); x.origin = 'USER'; return x; }));
    /* every book's main-line overround (for one-sided alternates) */
    latestQuotes(quotes).forEach(function (q) {
      if (q.alternate || q.pseudo) return;
      var a = sidePriceOf(q, 'home'), b = sidePriceOf(q, 'away');
      if (a && a.valid && b && b.valid) ctx.main_overround[q.book_key] = a.break_even + b.break_even - 1;
    });
    var cons = consensusOf(quotes, now, cfg, input.integrity || null);
    ctx.market_margin = cons.available ? -cons.home_line : null;
    var fresh = freshnessAudit(quotes, (input.market && input.market.stored) || [], now, cfg);
    ctx.quote_check_blocks = fresh.checks.some(function (c) { return c.blocks_action; });
    var research = researchOf(input, cfg);
    var fair = ctx.fair_home_margin;
    var gapSigned = isNum(fair) && cons.available ? fair - ctx.market_margin : null;
    var side = isNum(gapSigned) && Math.abs(gapSigned) >= 0.05 ? (gapSigned > 0 ? 'home' : 'away') : null;
    ctx.gap_pts = isNum(gapSigned) ? Math.abs(gapSigned) : null;
    var live = latestQuotes(quotes);
    var quotesByBook = {};
    live.forEach(function (q) { if (!q.alternate && !q.pseudo) quotesByBook[q.book_key] = q; });
    var options = ctx.curve && isNum(fair) ? optionsOf(ctx, live).map(function (o, i) { return o; }) : [];
    /* keep each option's source quote (for liquidity and governed lookups) */
    options.forEach(function (o) { o._q = live.filter(function (q) { return q.quote_id === o.quote_id; })[0] || null; });
    var users = ctx.curve && isNum(fair) ? optionsOf(ctx, quotes.filter(function (q) { return q.origin === 'USER'; })) : [];
    /* the VIEW: every book (best available), one book, the reader's books, or the consensus */
    function inView(o) {
      if (view.mode === 'book' && view.book) return bookKey(o.book) === bookKey(view.book);
      if (view.mode === 'mine' && view.books && view.books.length) return view.books.map(bookKey).indexOf(bookKey(o.book)) >= 0;
      return true;
    }
    var sideAll = side ? options.filter(function (o) { return o.side === side; }) : [];
    var sideView = sideAll.filter(inView);
    ctx.all_stale = sideView.length > 0 && sideView.every(function (o) { return !o.fresh; });
    var freshView = sideView.filter(function (o) { return o.priced && o.fresh && !o.problem; });
    var mainView = freshView.filter(function (o) { return !o.alternate; }).sort(rankEv);
    var alt = alternatesFor(ctx, freshView, quotesByBook);
    var bestAnywhere = sideAll.filter(function (o) { return o.priced && o.fresh && !o.problem && !o.alternate; }).sort(rankEv)[0] || null;
    var consOpt = null;
    if (side && cons.available && !cons.stale && ctx.curve) {
      var cp = side === 'home' ? cons.price_home : cons.price_away;
      consOpt = evaluate(ctx, { side: side, line: side === 'home' ? cons.home_line : -cons.home_line, price: isNum(cp) ? cp : cfg.reference_price,
        quote: { book: 'consensus', book_key: 'consensus', source: cons.method, origin: 'CONSENSUS', observed_at: cons.as_of, price_home: side === 'home' ? cp : null, price_away: side === 'away' ? cp : null },
        hypothetical_market_fair: !isNum(cp) });
      consOpt.price_is_reference = !isNum(cp);
    }
    /* the SELECTED price: the consensus in consensus mode, else the best value in the view, else its best main line */
    var cur = view.mode === 'consensus' ? consOpt : (alt.best_value || mainView[0] || null);
    var bt = side ? bettableTo(ctx, side, cur) : null;
    /* the first number on EdgeDesk's side: the opener, else the earliest capture */
    var initial = null;
    if (side && ctx.curve) {
      var op = input.market && input.market.open;
      var earliest = quotes.filter(function (q) { return q.origin === 'LEDGER' && !q.alternate && !q.pseudo && isNum(q.home_line); }).sort(function (a, b) { return ms(a.observed_at) - ms(b.observed_at); })[0];
      if (op && isNum(num(op.home_line))) {
        var ophl = num(op.home_line), oprice = side === 'home' ? num(op.price_home) : num(op.price_away);
        initial = evaluate(ctx, { side: side, line: side === 'home' ? ophl : -ophl, price: isNum(oprice) ? oprice : cfg.reference_price, hypothetical_market_fair: !isNum(oprice),
          quote: { book: op.book || 'open', book_key: bookKey(op.book || 'open'), source: op.source || 'opener', origin: 'OPEN', observed_at: op.observed_at || op.at || null, price_home: null, price_away: null } });
      } else if (earliest) {
        var ep = sidePriceOf(earliest, side);
        initial = evaluate(ctx, { side: side, line: side === 'home' ? earliest.home_line : -earliest.home_line, price: ep && ep.valid ? ep : cfg.reference_price, quote: earliest, hypothetical_market_fair: !(ep && ep.valid) });
      }
    }
    /* price gone compares like with like: the first main number against the current main number */
    var pg = side ? priceGoneOf(ctx, side, initial, (view.mode === 'consensus' ? consOpt : (mainView[0] || cur))) : { state: 'UNKNOWN', text: null };
    /* the market's first number: the opener, else the earliest capture of a real book (labelled as such) */
    var firstMk = input.market && input.market.open && isNum(num(input.market.open.home_line)) ? input.market.open : null;
    if (!firstMk) {
      var e0 = quotes.filter(function (q) { return q.origin === 'LEDGER' && !q.alternate && !q.pseudo && isNum(q.home_line) && ms(q.observed_at) != null; }).sort(function (a, b) { return ms(a.observed_at) - ms(b.observed_at); })[0];
      if (e0) firstMk = { home_line: e0.home_line, observed_at: e0.observed_at, source: 'first capture (' + e0.book + ')' };
    }
    var mv = movementOf(ctx, cons, firstMk, { best: bestAnywhere ? bestAnywhere.label : null, selected: cur ? cur.label : null });
    ctx.movement = mv;
    var qb = qbState(input);
    if (side && cons.available) {
      var consLine0 = side === 'home' ? cons.home_line : -cons.home_line, best0 = bestAnywhere || cur;
      ctx.book_edge_pts = best0 ? best0.line - consLine0 : null;
    }
    var T = timingOf(ctx, input, research, side, cur, bt, pg, mv, qb, alt, cons);
    /* a raw clear on a small gap is not a price to act on: its threshold is labelled for what it is */
    if (bt && T.reason_code === 'SMALL_GAP_RAW') bt.label = 'RAW THRESHOLD';
    /* WHY NOT BET: every blocker, in order, for any non-BET with an apparent disagreement */
    var whyNot = [];
    if (T.timing_read !== 'BET' && T.timing_read !== 'BET_EARLY') {
      whyNot.push({ code: T.reason_code, text: T.reason });
      if (isNum(ctx.gap_pts) && ctx.gap_pts >= cfg.research_gap) whyNot.push({ code: 'MODEL_GAP', text: 'Model gap ' + pts(ctx.gap_pts) + ' toward ' + teamOf(ctx, side) + '.' });
      if (cur && cur.priced) whyNot.push({ code: 'PRICE', text: 'At ' + cur.label + ': cover ' + pct(cur.cover_used, 1) + (cur.cover_basis === 'RAW' ? ' (raw)' : ' (calibrated)') + ' vs break-even ' + pct(cur.break_even, 1) + ' — ' + cur.threshold.text + '.' });
      if (!cal.validated && T.reason.indexOf('CALIBRATION PENDING') < 0) whyNot.push({ code: 'CALIBRATION_PENDING', text: 'CALIBRATION PENDING: ' + stop(cal.reason) + '.' });
      if (input.policy && input.policy.bet_enabled === false) whyNot.push({ code: 'BETTING_DISABLED', text: 'Betting is disabled by the frozen decision policy until it passes its promotion gate.' });
      if (input.policy && input.policy.calibrated_ev_note) whyNot.push({ code: 'CALIBRATED_EV', text: input.policy.calibrated_ev_note });
      if (cons.available && cons.n_books < cfg.min_books) whyNot.push({ code: 'THIN_MARKET', text: cons.n_books + ' fresh book' + (cons.n_books === 1 ? '' : 's') + ' (a consensus needs ' + cfg.min_books + ').' });
      qb.unresolved.forEach(function (t) { whyNot.push({ code: 'QB', text: stop(t) + '.' }); });
    }
    var seen = {};
    whyNot = whyNot.filter(function (x) { if (seen[x.code]) return false; seen[x.code] = 1; return true; });
    var edgeKind = null;
    if (side && cons.available && isNum(ctx.gap_pts)) {
      var consLine = side === 'home' ? cons.home_line : -cons.home_line;
      var best = bestAnywhere || cur;
      var bookEdge = best ? best.line - consLine : null;
      var modelE = ctx.gap_pts;
      var kind = isNum(bookEdge) && bookEdge >= cfg.book_edge_pts && modelE < cfg.research_gap ? 'BOOK_PRICE_EDGE'
        : (modelE >= cfg.research_gap && !(isNum(bookEdge) && bookEdge >= cfg.book_edge_pts) ? 'MODEL_EDGE' : (isNum(bookEdge) && bookEdge >= cfg.book_edge_pts ? 'BOTH' : 'NONE'));
      edgeKind = { kind: kind, model_edge_pts: r(modelE, 2), book_price_edge_pts: r(bookEdge, 2), book: best ? best.book : null,
        text: { BOOK_PRICE_EDGE: 'BOOK-SPECIFIC PRICE EDGE: ' + (best && best.book) + ' is ' + pts(bookEdge) + ' better than the consensus while EdgeDesk roughly agrees with the consensus. Check that the quote is current.',
          MODEL_EDGE: 'FOOTBALL-MODEL EDGE: EdgeDesk disagrees with the whole market by ' + pts(modelE) + ', not with one book.',
          BOTH: 'BOTH: EdgeDesk disagrees with the market by ' + pts(modelE) + ' and ' + (best && best.book) + ' is a further ' + pts(bookEdge) + ' off the consensus.',
          NONE: 'Neither a model edge of ' + cfg.research_gap + '+ points nor a book ' + cfg.book_edge_pts + '+ point off the consensus.' }[kind] };
    }
    var decay = input.context && input.context.edge_decay && input.context.edge_decay.available ? input.context.edge_decay : null;
    var decayOut = decay ? { available: true, initial_model_gap: decay.initial ? decay.initial.points : null, current_model_gap: decay.current ? decay.current.points : null,
      retained_share: decay.retained_share != null ? decay.retained_share : null, decay_pct: isNum(decay.retained_share) ? r(clamp(1 - decay.retained_share, -2, 2), 3) : null,
      verdict: decay.verdict, text: (decay.verdict_text ? decay.verdict_text + ' ' : '') + (decay.text || '') } : { available: false, text: 'No time when both EdgeDesk and the market were on file.' };
    var ag = agreementOf(input);
    var risks = riskOf(input, ctx, research, qb, cur);
    var altRow = alt.best_alt_row;
    var mainOpt = alt.main_line;
    var altSummaryText = !alt.captured ? 'No alternate spreads captured for this game.'
      : (altRow ? altRow.option.label + ' — ' + altRow.text : null);
    var fairSide = side ? fairLineForSide(ctx, side) : null;
    var stale = { stale: ctx.all_stale || cons.stale, text: cons.stale ? 'Every quote on file is older than ' + cfg.stale_minutes + ' minutes: no current price.' : (ctx.all_stale ? 'Every quote on EdgeDesk’s side in this view is stale.' : null) };
    var validUntil = cur && cur.observed_at ? iso(ms(cur.observed_at) + cfg.stale_minutes * 60000) : null;
    var out = {
      schema: SCHEMA, version: VERSION, game_id: g.game_id != null ? String(g.game_id) : null, generated_at: iso(now),
      model_version: m.model_version || null, home: g.home, away: g.away, kickoff: g.kickoff || null,
      view: { mode: view.mode || 'best', book: view.book || null, books: view.books || null },
      fair_spread: isNum(fair) ? { home_margin: r(fair, 2), home_line: r(-fair, 2), text: fairText(fair, g.home, g.away) } : null,
      fair_total: num(m.fair_total), projected_margin: isNum(fair) ? r(fair, 2) : null,
      projected_score: isNum(num(m.home_points)) && isNum(num(m.away_points)) ? { home: r(m.home_points, 1), away: r(m.away_points, 1) } : null,
      market_consensus_spread: cons.available ? { home_line: cons.home_line, text: fairText(-cons.home_line, g.home, g.away), n_books: cons.n_books, method: cons.method, stale: cons.stale, as_of: cons.as_of } : null,
      consensus: cons,
      side: side, side_team: side ? teamOf(ctx, side) : null,
      fair_line_for_side: isNum(fairSide) ? r(fairSide, 2) : null,
      selected_book: cur ? cur.book : null, selected_book_spread: cur ? cur.line : null, selected_book_price: cur && cur.price ? cur.price.american : null,
      selected: cur ? stripOption(cur) : null,
      quote_age_seconds: cur && isNum(cur.age_minutes) ? Math.round(cur.age_minutes * 60) : null,
      valid_until: validUntil,
      model_market_gap: isNum(gapSigned) ? { points: r(Math.abs(gapSigned), 2), toward: side, toward_team: side ? teamOf(ctx, side) : null, signed_home: r(gapSigned, 2) } : null,
      cushion: cur ? cur.cushion : null,
      cover_probability: cur && cur.priced ? cur.cover_used : null, raw_cover_probability: cur && cur.priced ? cur.raw_cover : null,
      calibrated_cover_probability: cur && cur.calibrated ? cur.calibrated.decision_cover : null,
      push_probability: cur && cur.probability ? cur.probability.push : null, loss_probability: cur && cur.probability ? cur.probability.loss : null,
      win_probability: cur && cur.probability ? cur.probability.win : null,
      break_even_probability: cur ? cur.break_even : null,
      estimated_ev: cur ? cur.ev : null, raw_ev: cur ? cur.raw_ev : null, decision_ev: cur ? cur.decision_ev : null, ev_after_buffer: cur ? cur.buffered_ev : null,
      edge: cur ? cur.edge : null,
      probability_basis: cal.validated ? 'CALIBRATED' : 'RAW',
      calibration: { status: cal.status, version: cal.version, base_model_version: cal.base_model_version, reason: cal.reason },
      football_confidence: input.context && input.context.football_confidence ? input.context.football_confidence : null,
      reliability: input.context && isNum(num(input.context.reliability)) ? num(input.context.reliability) : null,
      model_agreement: ag,
      market_freshness: marketFreshness(ctx, cons, cur, input),
      research_status: research,
      decision_status: T.decision_status, timing_read: T.timing_read, timing_reason: T.reason, timing_code: T.reason_code, timing_means: T.means,
      actionable: T.decision_status === 'BET' || T.decision_status === 'BET_EARLY',
      target_price: T.target ? { line: T.target.line, price: T.target.price, text: teamOf(ctx, side) + ' ' + lineText(T.target.line) + ' ' + priceText(T.target.price) + ' or better', distance_pts: T.target.distance_pts } : null,
      urgency: T.urgency || null,
      preferred_line: cur ? cur.line : (bt && isNum(bt.preferred_line) ? bt.preferred_line : null),
      preferred_price: cur && cur.price ? cur.price.american : null,
      bettable_to: bt,
      price_status: priceStatus(cur, pg, stale, T),
      price_is_gone: pg,
      best_value_market: alt.best_value && T.reason_code !== 'SMALL_GAP_RAW' ? { type: alt.best_value.alternate ? 'ALTERNATE_SPREAD' : 'MAIN_SPREAD', label: alt.best_value.label, book: alt.best_value.book, ev_after_buffer: alt.best_value.ev_threshold }
        : { type: 'NONE', label: null, text: T.reason_code === 'SMALL_GAP_RAW' ? 'A raw edge on a gap under the research threshold is not claimed as value.' : 'No available price clears the threshold.' },
      best_available: bestAnywhere ? stripOption(bestAnywhere) : null,
      consensus_read: consOpt ? stripOption(consOpt) : null,
      main_vs_alt_summary: { main_line: mainOpt ? mainOpt.label : null, best_alt: alt.best_alt ? alt.best_alt.label : null, safest_alt: alt.safest_alt ? alt.safest_alt.label : null,
        best_value: alt.best_value ? alt.best_value.label : null, alt_verdict: altRow ? altRow.verdict : null, text: altSummaryText, captured: alt.captured, note: alt.note },
      alternates: { rows: alt.rows.map(function (x) { return { option: stripOption(x.option), vs_main: x.vs_main, verdict: x.verdict, text: x.text, liquidity: x.liquidity }; }), overpriced: alt.overpriced },
      line_shopping: sideAll.filter(function (o) { return o.priced && !o.alternate; }).sort(rankEv).map(stripOption),
      price_curve: side && ctx.curve ? priceCurve(ctx, side, freshView, alt.best_value, cur ? cur.line : (isNum(ctx.market_margin) ? (side === 'home' ? -ctx.market_margin : ctx.market_margin) : null)) : null,
      market_movement_summary: mv,
      edge_decay: decayOut,
      edge_kind: edgeKind,
      stale_market: stale,
      quote_freshness: fresh,
      market_quote_check: fresh.quote_check ? fresh.checks : [],
      why_edgedesk_differs: whyDiffers(input),
      risk_summary: risks,
      what_would_make_us_wrong: risks.filter(function (x) { return x.severity === 'high' || x.code === 'WHAT_WOULD_HAVE_TO_BE_WRONG' || x.code === 'MODEL_DISAGREEMENT' || x.code === 'TYPICAL_MISS'; }).map(function (x) { return x.text; }),
      qb_status: qb,
      why_not_bet: whyNot,
      integrity_status: { gate: research.integrity_gate, status: research.status, blocks_action: research.blocks_action, quote_check_blocks: ctx.quote_check_blocks },
      user_quotes: users.map(stripOption),
      markets: { spread: { status: 'ACTIVE', probability: cal.validated ? 'CALIBRATED' : 'RAW (calibration pending)' },
        total: { status: 'NOT_ACTIVATED', reason: 'no validated total distribution calibration (football/validation/pricing_cfb.json tier RESEARCH)' },
        team_total: { status: 'NOT_ACTIVATED', reason: 'no team-total distribution is published' },
        moneyline: moneylineOf(input, cfg) },
      maturity: maturityOf(input, cal, alt),
      config: { min_probability_edge: cfg.min_probability_edge, ideal_probability_edge: cfg.ideal_probability_edge, min_ev: cfg.min_ev, stale_minutes: cfg.stale_minutes,
        reference_price: cfg.reference_price, typical_move_pts: cfg.typical_move_pts, key_numbers: cfg.key_numbers },
      principle: 'Read the price, not just the team: this read is about ' + (cur ? cur.label : 'the current price') + '. At a different number the same football opinion can be a pass.'
    };
    out.frontier = side && out.price_curve ? frontier(ctx, side, freshView, out.price_curve.ladder) : null;
    out.why_wait = (T.timing_read === 'WAIT' || T.timing_read === 'PRICE_TARGET') ? whyWait(out, T, cfg) : null;
    out.why_bet_early = T.timing_read === 'BET_EARLY' ? whyBetEarly(out, T) : null;
    out.headline = headline(out);
    out.language = auditText(collectText(out));
    return deepFreeze(out);
  }
  function fairText(margin, home, away) {
    if (!isNum(margin)) return null;
    if (Math.abs(margin) < 0.05) return 'Pick’em';
    return (margin > 0 ? home : away) + ' -' + Math.abs(margin).toFixed(1);
  }
  function stripOption(o) {
    if (!o) return null;
    var x = {}, k;
    for (k in o) if (has(o, k) && k !== '_q') x[k] = o[k];
    return x;
  }
  function priceStatus(cur, pg, stale, T) {
    if (stale && stale.stale && !cur) return { key: 'STALE_QUOTE', label: 'STALE QUOTE' };
    if (!cur || !cur.priced) return { key: 'NOT_PRICED', label: 'NOT PRICED' };
    if (T.timing_read === 'INVESTIGATE') return { key: 'NOT_PRICED', label: 'NOT PRICED UNTIL VERIFIED' };
    if (T.reason_code === 'SMALL_GAP_RAW') return { key: 'NO_VALUE_CLAIMED', label: 'NO VALUE CLAIMED (RAW, GAP UNDER 2)' };
    if (pg && pg.state === 'GONE') return { key: 'PRICE_GONE', label: 'PRICE GONE' };
    if (pg && pg.state === 'MOSTLY_GONE') return { key: 'PRICE_MOSTLY_GONE', label: 'PRICE MOSTLY GONE' };
    if (cur.clears) return { key: 'VALUE', label: 'VALUE AT THIS PRICE' };
    if (cur.grade === 'MARGINAL') return { key: 'MARGINAL', label: 'MARGINAL' };
    return { key: 'NO_VALUE', label: 'NO VALUE AT THIS PRICE' };
  }
  function marketFreshness(ctx, cons, cur, input) {
    /* decision.js marketConfidence: quote age, book breadth, agreement, two-sided prices. Kept apart from football confidence. */
    if (!cur || !cur.observed_at) return { score: null, label: 'UNKNOWN', basis: ['no current quote'] };
    try {
      var P = { stale_minutes: ctx.cfg.stale_minutes, min_books: ctx.cfg.min_books, max_dispersion_iqr: ctx.cfg.max_dispersion_iqr };
      var q = { observed_at: cur.observed_at, provider_updated_at: cur._q ? cur._q.provider_updated_at : null,
        price_home: cur._q ? num(cur._q.price_home) : null, price_away: cur._q ? num(cur._q.price_away) : null };
      var mc = dec().marketConfidence(q, { books: cons.n_books, dispersion_iqr: cons.dispersion }, ctx.now, P);
      return { score: mc.score, label: mc.label, age_minutes: mc.age_minutes, books: mc.books, dispersion: mc.dispersion_iqr, basis: mc.basis,
        note: 'market freshness, not football confidence: how trustworthy the offered number is right now' };
    } catch (e) { return { score: null, label: 'UNKNOWN', basis: ['market confidence could not be computed'] }; }
  }
  function maturityOf(input, cal, alt) {
    var P = input.policy || {};
    return [
      { item: 'Fair line', status: 'PRODUCTION', note: 'the governance champion’s number' },
      { item: 'Cover probability', status: cal.validated ? 'CALIBRATED' : 'RAW · CALIBRATION PENDING', note: cal.validated ? 'decision calibration ' + cal.version : cal.reason },
      { item: 'Estimated EV', status: cal.validated ? 'CALIBRATED · EXPERIMENTAL' : 'RESEARCH', note: P.calibrated_ev_note || 'per unit risked, at the exact price' },
      { item: 'Bettable to / target', status: 'EXPERIMENTAL', note: 'the policy’s probability-edge threshold on ' + (cal.validated ? 'the calibrated' : 'the raw') + ' probability' },
      { item: 'Timing (bet early / wait)', status: 'EXPERIMENTAL', note: P.wait && P.wait.enabled ? 'the policy validated a WAIT rule' : 'no validated evidence that waiting pays (the policy’s WAIT rule is disabled); tracked from this build on' },
      { item: 'Alternate value', status: alt.captured ? 'SHADOW' : 'SHADOW · NO ALTERNATES CAPTURED', note: 'priced by the same distribution; alternate-line decisions are recorded and graded before any claim' },
      { item: 'Key numbers', status: 'EMPIRICAL', note: 'FBS final-margin shares and the champion’s own PMF' },
      { item: 'Consensus / quote freshness', status: 'PRODUCTION', note: 'the Model Lab’s integrity and freshness rules' },
      { item: 'CLV tracking', status: 'PENDING', note: 'read snapshots are frozen and graded against the close from this build on' },
      { item: 'Betting', status: P.bet_enabled ? 'ENABLED' : 'DISABLED', note: 'decision policy ' + (P.version || '—') }
    ];
  }
  function whyWait(o, T, cfg) {
    var rows = [];
    if (o.selected) rows.push({ k: 'CURRENT', v: o.selected.label });
    if (o.target_price) rows.push({ k: 'TARGET', v: o.target_price.text });
    if (o.fair_line_for_side != null) rows.push({ k: 'MODEL FAIR', v: o.side_team + ' ' + lineText(o.fair_line_for_side) });
    rows.push({ k: 'MARKET', v: o.market_movement_summary.direction === 'UNKNOWN' ? 'direction unknown (no opener)' : o.market_movement_summary.direction.toLowerCase() });
    rows.push({ k: 'WHY', v: T.reason });
    if (T.reason_code === 'TARGET') rows.push({ k: 'URGENCY', v: 'none detected — EdgeDesk does not forecast line movement; the target is ' + pts(o.target_price.distance_pts) + ' away, inside ordinary movement (' + cfg.typical_move_pts + ' pts)' });
    return rows;
  }
  function whyBetEarly(o, T) {
    var rows = [{ k: 'CURRENT', v: o.selected.label }];
    if (o.bettable_to && o.bettable_to.line != null) rows.push({ k: 'BETTABLE', v: o.side_team + ' ' + lineText(o.bettable_to.line) + ' or better' });
    rows.push({ k: 'MARKET TREND', v: o.market_movement_summary.direction === 'TOWARD' ? 'toward EdgeDesk' : (o.market_movement_summary.direction || 'unknown').toLowerCase() });
    (T.urgency && T.urgency.reasons || []).forEach(function (x) { rows.push({ k: x.code === 'KEY_NUMBER_AT_RISK' ? 'RISK' : 'WHY', v: x.text }); });
    return rows;
  }
  function headline(o) {
    var s = o.selected;
    return {
      read: o.timing_read.replace(/_/g, ' '),
      best_value: o.best_value_market.label || (s ? s.label : null),
      fair: o.fair_spread ? o.fair_spread.text : null,
      market: o.market_consensus_spread ? o.market_consensus_spread.text + (o.market_consensus_spread.stale ? ' (stale)' : '') : null,
      current: s ? s.label + (s.book ? ' · ' + s.book : '') : null,
      cushion: s && isNum(s.cushion) ? (s.cushion >= 0 ? '+' : '−') + Math.abs(s.cushion).toFixed(1) + ' pts' : null,
      cover: s && isNum(s.cover_used) ? pct(s.cover_used, 1) + (s.cover_basis === 'RAW' ? ' raw' : '') : null,
      break_even: s && isNum(s.break_even) ? pct(s.break_even, 1) : null,
      ev: s && isNum(s.ev) ? evText(s.ev) + (s.cover_basis === 'RAW' ? ' (raw — calibration pending)' : '') : null,
      bettable_to: o.bettable_to && o.bettable_to.line != null ? o.bettable_to.text : 'no nearby number clears',
      bettable_label: o.bettable_to ? o.bettable_to.label : 'BETTABLE TO',
      target: o.target_price ? o.target_price.text : null,
      timing: o.timing_read.replace(/_/g, ' '),
      price_status: o.price_status.label,
      market_trend: o.market_movement_summary.text,
      alt: o.main_vs_alt_summary.text,
      research_status: o.research_status.label
    };
  }
  function collectText(o) {
    var t = [o.timing_reason, o.principle, o.market_movement_summary.text, o.price_is_gone.text, o.main_vs_alt_summary.text, o.edge_kind ? o.edge_kind.text : null]
      .concat(o.why_not_bet.map(function (x) { return x.text; })).concat(o.alternates.rows.map(function (x) { return x.text + ' ' + (x.vs_main ? x.vs_main.why : ''); }));
    return t.filter(Boolean).join(' \n ');
  }
  function auditText(text) {
    var problems = [];
    BANNED.forEach(function (re) { if (re.test(text)) problems.push('forbidden wording: ' + re); });
    return { ok: problems.length === 0, problems: problems };
  }

  /* =========================================================== INTERACTIONS
     All three recompute from the same stored input: no model run, only the
     stored curve and the same threshold. */
  function contextOf(input, over) {
    var cfg = config(over || input.config), m = input.model || {};
    var ctx = { cfg: cfg, now: ms(input.now) || Date.now(), curve: input.curve || null, calibration: calibrationOf(input), home: input.game.home, away: input.game.away,
      fair_home_margin: num(m.home_margin), key_mass: (input.context && input.context.key_mass) || null, main_overround: {} };
    return ctx;
  }
  /* "Minnesota +6.5 -115", "+6.5 -115", "MIN +6.5 (53%)", "Rice 11.5 1.91" */
  function parseQuoteText(text, game) {
    var t = String(text || '').replace(/[−–—]/g, '-').trim(), g = game || {};
    var m = /^(.*?)([+-]?\d+(?:\.\d)?|pk|pick(?:'?em)?)\s*(?:\(?\s*([+-]?\d{3,5}|\d+(?:\.\d+)?%?|\d\.\d+)\s*\)?)?\s*(?:@\s*|at\s+)?([a-z][a-z0-9 .&']*)?$/i.exec(t);
    if (!m) return { ok: false, problem: 'could not read a line and price from "' + text + '"' };
    var who = String(m[1] || '').trim().toLowerCase(), lineRaw = String(m[2]).toLowerCase();
    var line = /^pk|^pick/.test(lineRaw) ? 0 : parseFloat(lineRaw);
    var side = null;
    function matches(name) { var n = String(name || '').toLowerCase(); return !!who && (n.indexOf(who) === 0 || who.indexOf(n) === 0 || n.split(/\s+/)[0] === who.split(/\s+/)[0]); }
    if (who) { if (matches(g.home)) side = 'home'; else if (matches(g.away)) side = 'away'; }
    var price = m[3] ? parsePrice(m[3]) : null;
    var book = m[4] ? String(m[4]).trim() : null;
    if (!side && who) return { ok: false, problem: '"' + m[1].trim() + '" is neither ' + g.home + ' nor ' + g.away };
    return { ok: true, side: side, line: line, price: price, book: book, text: text };
  }
  function evaluateQuote(input, spec, over) {
    var ctx = contextOf(input, over);
    var price = spec.price && spec.price.valid !== undefined ? spec.price : normalizePrice(spec.price);
    return stripOption(evaluate(ctx, { side: spec.side, line: spec.line, price: price, hypothetical_market_fair: spec.market_fair !== false && !spec.other_price,
      quote: { book: spec.book || null, book_key: bookKey(spec.book), source: spec.source || 'user', origin: spec.origin || 'USER', observed_at: spec.observed_at || null,
        price_home: spec.side === 'home' ? spec.price : spec.other_price || null, price_away: spec.side === 'away' ? spec.price : spec.other_price || null, quote_id: null } }));
  }
  /* COMPARE LINES: two or more prices for the same side, ranked by value */
  function compare(input, specs, over) {
    var ctx = contextOf(input, over);
    var opts = (specs || []).map(function (s) {
      var price = s.price && s.price.valid !== undefined ? s.price : normalizePrice(s.price);
      return evaluate(ctx, { side: s.side, line: s.line, price: price, hypothetical_market_fair: true,
        quote: { book: s.book || null, book_key: bookKey(s.book), source: s.source || null, origin: s.origin || 'USER', observed_at: s.observed_at || null, price_home: null, price_away: null } });
    });
    if (opts.length < 2) return { ok: false, problem: 'compare needs two prices' };
    if (opts.some(function (o) { return o.side !== opts[0].side; })) return { ok: false, problem: 'compare prices for one side at a time' };
    var base = opts[0], pairs = [];
    for (var i = 1; i < opts.length; i++) pairs.push(compareOptions(ctx, base, opts[i]));
    var ranked = opts.slice().sort(rankEv);
    var best = ranked[0];
    var result = best.clears ? best.label + ' OFFERS BETTER VALUE' : 'NEITHER CLEARS THE THRESHOLD — ' + best.label + ' is the lesser pass';
    if (opts.length === 2 && pairs[0] && pairs[0].better === 'EQUAL') result = 'EQUIVALENT VALUE';
    return { ok: true, options: opts.map(stripOption), comparisons: pairs, best: stripOption(best), result: result,
      basis: ctx.calibration.validated ? 'calibrated decision probability' : 'raw model probability (calibration pending)' };
  }
  /* WHAT IF THIS LINE MOVES? — the same side at a new number (and price) */
  function whatIf(input, spec, over) {
    var ctx = contextOf(input, over);
    var price = spec.price == null ? ctx.cfg.reference_price : spec.price;
    var o = evaluate(ctx, { side: spec.side, line: spec.line, price: price, hypothetical_market_fair: true,
      quote: { book: spec.book || null, book_key: bookKey(spec.book), source: 'what-if', origin: 'HYPOTHETICAL', observed_at: null, price_home: null, price_away: null } });
    var bt = bettableTo(ctx, spec.side, o);
    var status = o.problem ? 'NOT PRICED' : (o.clears ? 'CLEARS THE THRESHOLD' : (o.grade === 'MARGINAL' ? 'MARGINAL — UNDER THE THRESHOLD' : 'PASS'));
    return { option: stripOption(o), status: status, bettable_to: bt,
      text: o.problem ? o.problem : o.label + ': cover ' + pct(o.cover_used, 1) + ' vs break-even ' + pct(o.break_even, 1) + ' (' + pp(o.edge) + '), EV ' + evText(o.ev) + ' — ' + status + '.',
      note: 'The distribution stays conditioned on the current market (as the price curve is); a hypothetical number is never a certified bet.' };
  }
  /* MANUAL PRICE ENTRY — a USER QUOTE: evaluated, never stored as consensus, never certified */
  function manual(input, text, over) {
    var p = typeof text === 'string' ? parseQuoteText(text, input.game) : text;
    if (!p || !p.ok) return { ok: false, problem: p ? p.problem : 'no quote' };
    var side = p.side || input.default_side || null;
    if (!side) return { ok: false, problem: 'name the team (' + input.game.home + ' or ' + input.game.away + ')' };
    if (!p.price || !p.price.valid) return { ok: false, problem: 'a line without a price is not a complete price: add the juice (e.g. ' + (side === 'home' ? input.game.home : input.game.away) + ' ' + lineText(p.line) + ' -110)' };
    var o = evaluateQuote(input, { side: side, line: p.line, price: p.price, book: p.book, origin: 'USER', observed_at: iso(input.now || Date.now()) }, over);
    var ctx = contextOf(input, over);
    var check = null;
    if (p.book) {
      var stored = ((input.market && input.market.quotes) || []).map(normalizeQuote).filter(function (q) { return q.book_key === bookKey(p.book) && !q.alternate && isNum(q.home_line); })
        .sort(function (a, b) { return ms(b.observed_at) - ms(a.observed_at); })[0];
      if (stored) {
        var storedSide = side === 'home' ? stored.home_line : -stored.home_line;
        if (Math.abs(storedSide - p.line) >= ctx.cfg.quote_check_pts - 1e-9) {
          var age = quoteAgeMinutes(stored, ctx.now);
          check = { kind: 'USER_QUOTE_DIFFERS', book: stored.book, edgedesk_line: storedSide, edgedesk_at: stored.observed_at, edgedesk_age_minutes: r(age, 0), your_line: p.line,
            text: 'MARKET QUOTE CHECK: EdgeDesk’s last ' + stored.book + ' capture was ' + lineText(storedSide) + ' (' + (isNum(age) ? Math.round(age) + ' min ago' : 'unknown age') + '); you entered ' + lineText(p.line) + '. '
              + (isNum(age) && age > ctx.cfg.stale_minutes ? 'EdgeDesk’s capture is stale — your number is likely the current one.' : 'Confirm at the book.') };
        }
      }
    }
    return { ok: true, origin: 'USER_QUOTE', option: o, quote_check: check, whatif: whatIf(input, { side: side, line: p.line, price: p.price }, over).bettable_to,
      note: 'A USER QUOTE: evaluated with EdgeDesk’s distribution and the same threshold, never stored as consensus and never a certified bet.' };
  }

  /* ================================================================ ASK
     The assistant reads the Read. It never recomputes a probability, an EV
     or a status: it names the numbers the deterministic functions produced. */
  var INTENTS = [
    { id: 'main_or_alt', re: /(\balt\b|\balternate|\bbuy(ing)? (a |the )?(point|hook)|[+-]\d+(\.5)? or [+-]?\d|\bor the alt|\bextra point)/i },
    { id: 'juice', re: /\b(juice|vig|worth (the|it)|extra (juice|price|cost))\b/i },
    { id: 'bet_now', re: /\b(bet (this|it) now|now or|act now|should i bet|take (it|this) now|lock (it )?in)\b/i },
    { id: 'wait', re: /\b(wait|better number|hold off|later)\b/i },
    { id: 'worst_number', re: /\b(worst (number|line|price)|bettable|how (low|far) would you|minimum (line|number))\b/i },
    { id: 'pass_price', re: /((price|number|line).{0,30}\bpass\b|\bpass at\b|when would you pass|at what (price|number|line))/i },
    { id: 'best_book', re: /\b(which book|best (price|book|number)|where.*bet|line shop)/i },
    { id: 'value_gone', re: /\b(value (gone|disappear)|missed|price gone|still (good|there)|decay)/i },
    { id: 'edge_kind', re: /\b(stale.book|book edge|model edge|stale line|stale quote)\b/i },
    { id: 'why_not', re: /(why (is |isn'?t |'?s )?(this |it )?(not |no )?(a )?bet\b|why (not|no) (a )?bet|why pass|not a bet\b|why not\b)/i },
    { id: 'wrong', re: /\b(wrong|risk|could (go|make)|what would)\b/i },
    { id: 'likes', re: /\b(why (does )?edgedesk (like|differ)|why (do|does) (you|it) like)\b/i }
  ];
  function ask(question, o) {
    var q = String(question || ''), id = null;
    for (var i = 0; i < INTENTS.length; i++) if (INTENTS[i].re.test(q)) { id = INTENTS[i].id; break; }
    if (!o) return { intent: id, text: 'No EdgeDesk Read for this game.', facts: [] };
    var s = o.selected, facts = [];
    function f(claim, source) { facts.push({ claim: claim, source: source || 'edgeDeskRead', updated: o.generated_at, confidence: 'deterministic' }); }
    var text;
    switch (id) {
      case 'main_or_alt':
      case 'juice': {
        var rows = o.alternates.rows;
        if (!rows.length) { text = 'No alternate spread was captured for this game. ' + (s ? 'The main line is ' + s.label + ' (cover ' + pct(s.cover_used, 1) + ' vs break-even ' + pct(s.break_even, 1) + ').' : '') + ' Enter the alternate you see with its price (for example ' + (o.side_team || o.home) + ' ' + (s ? lineText(s.line + 1) : '') + ' and the price your book shows) and EdgeDesk prices it with the same distribution and the same threshold.'; f(text, 'alternates'); break; }
        var b = rows.slice().sort(function (x, y) { return (y.vs_main && y.vs_main.ev_change_after_buffer || -9) - (x.vs_main && x.vs_main.ev_change_after_buffer || -9); })[0];
        text = b.option.label + ' vs ' + (o.main_vs_alt_summary.main_line || 'the main line') + ': ' + (b.vs_main ? b.vs_main.why + ' ' : '') + 'Verdict: ' + b.text + '.';
        f(text, 'alternates');
        break;
      }
      case 'bet_now':
        text = o.timing_read.replace(/_/g, ' ') + '. ' + o.timing_reason;
        f(o.timing_read, 'timing engine');
        break;
      case 'wait':
        text = (o.timing_read === 'PRICE_TARGET' || o.timing_read === 'WAIT') ? o.timing_reason : 'EdgeDesk does not read this as a wait: ' + o.timing_reason;
        f(o.timing_read, 'timing engine');
        break;
      case 'worst_number':
      case 'pass_price':
        text = o.bettable_to && o.bettable_to.line != null ? (o.bettable_to.current_clears ? 'Bettable to ' : 'The current number does not clear. It needs ') + o.side_team + ' ' + lineText(o.bettable_to.line) + ' ' + priceText(o.bettable_to.reference_price) + (o.bettable_to.current_clears ? ' equivalent' : ' or better') + '; pass at ' + lineText(o.bettable_to.pass_beyond) + ' or worse.'
          + (o.bettable_to.price_at_current_line != null && s ? ' At ' + lineText(s.line) + ', the worst price that still clears is ' + priceText(o.bettable_to.price_at_current_line) + '.' : '')
          : 'No nearby number clears the threshold' + (o.side_team ? ' for ' + o.side_team : '') + ': it is a pass at every number within ten points of the current one.';
        f(text, 'bettable-to');
        break;
      case 'best_book':
        text = o.line_shopping.length ? 'Ranked by EdgeDesk’s expected value (not by the biggest number or the lowest juice alone): ' + o.line_shopping.slice(0, 4).map(function (x) { return x.label + ' at ' + (x.book || '—') + ' (EV ' + evText(x.ev) + (x.fresh ? '' : ', stale') + ')'; }).join('; ') + '.'
          : 'No priced quote on EdgeDesk’s side.';
        if (o.line_shopping.length === 1) text += ' Only one book is on file, so there is nothing to shop.';
        f(text, 'line shopping');
        break;
      case 'value_gone':
        text = 'Price: ' + (o.price_is_gone.text || 'no first number on file to compare.') + (o.edge_decay.available ? ' Gap: ' + o.edge_decay.text : '');
        f(o.price_is_gone.state, 'price gone');
        break;
      case 'edge_kind':
        text = o.edge_kind ? o.edge_kind.text : 'No market to compare with.';
        if (o.market_quote_check.length) text += ' ' + o.market_quote_check.map(function (c) { return 'MARKET QUOTE CHECK: ' + c.resolution; }).join(' ');
        f(text, 'edge kind');
        break;
      case 'why_not':
        text = o.actionable ? 'It is a certified ' + o.decision_status.replace('_', ' ') + '.' : o.why_not_bet.map(function (x) { return x.text; }).join(' ');
        f(text, 'why not bet');
        break;
      case 'wrong':
        text = o.risk_summary.length ? o.risk_summary.slice(0, 5).map(function (x) { return x.text; }).join(' ') : 'No structured risk on file.';
        f(text, 'risk summary');
        break;
      case 'likes':
        text = o.why_edgedesk_differs.available ? 'EdgeDesk’s terms: ' + o.why_edgedesk_differs.rows.map(function (x) { return x.text; }).join('; ') + (o.why_edgedesk_differs.final_fair ? ' → ' + o.why_edgedesk_differs.final_fair : '') + '.' : o.why_edgedesk_differs.text;
        f(text, 'decomposition');
        break;
      default:
        return null;
    }
    return { intent: id, text: text, facts: facts, source: 'edgeDeskRead ' + o.version + ' built ' + o.generated_at };
  }

  /* ========================================================= RECORD
     A Read snapshot freezes the book, line, odds, time, fair, probability,
     EV and statuses the moment a signal is produced. It is never edited and
     never regraded at a better line. */
  function snapshotId(parts) {
    var s = JSON.stringify(parts), h = 0x811c9dc5, h2 = 0x01000193, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0; }
    return 'edr_' + ('00000000' + h.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }
  var RECORDABLE = ['BET_EARLY', 'BET', 'WAIT', 'PRICE_TARGET', 'RESEARCH', 'PRICE_GONE', 'PASS'];
  function shouldRecord(o) {
    if (!o || RECORDABLE.indexOf(o.timing_read) < 0) return false;
    /* a PASS is recorded only when there was an apparent disagreement (for counterfactual grading) */
    if (o.timing_read === 'PASS') return !!(o.model_market_gap && o.model_market_gap.points >= 2 && o.selected);
    return true;
  }
  function snapshot(o) {
    var s = o.selected || null;
    var row = {
      schema: 'edgedesk_read_snapshot_v1', game_id: o.game_id, kickoff: o.kickoff, recorded_at: o.generated_at, model_version: o.model_version,
      home: o.home, away: o.away, side: o.side, team: o.side_team,
      book: s ? s.book : null, source: s ? s.source : null, quote_id: s ? s.quote_id : null, quote_observed_at: s ? s.observed_at : null,
      line: s ? s.line : null, price: s && s.price ? s.price.american : null, price_precision: s && s.price ? s.price.precision : null,
      fair_home_margin: o.projected_margin, fair_line_for_side: o.fair_line_for_side, market_home_line: o.market_consensus_spread ? o.market_consensus_spread.home_line : null,
      cover_probability: o.cover_probability, raw_cover_probability: o.raw_cover_probability, probability_basis: o.probability_basis,
      break_even: o.break_even_probability, estimated_ev: o.estimated_ev, ev_after_buffer: o.ev_after_buffer,
      timing_read: o.timing_read, decision_status: o.decision_status, research_status: o.research_status.status, reason_code: o.timing_code,
      bettable_to_line: o.bettable_to ? o.bettable_to.line : null, target_line: o.target_price ? o.target_price.line : null, target_price: o.target_price ? o.target_price.price : null,
      main_line: o.main_vs_alt_summary.main_line, best_alt: o.main_vs_alt_summary.best_alt, best_value: o.main_vs_alt_summary.best_value, alt_verdict: o.main_vs_alt_summary.alt_verdict,
      alt_rows: o.alternates.rows.map(function (x) { return { label: x.option.label, book: x.option.book, line: x.option.line, price: x.option.price ? x.option.price.american : null, ev_after_buffer: x.option.ev_threshold, verdict: x.verdict }; }),
      main_ev_after_buffer: null,
      price_state: o.price_is_gone.state, market_direction: o.market_movement_summary.direction, calibration_status: o.calibration.status, official: false
    };
    var main = (o.line_shopping || [])[0];
    row.main_ev_after_buffer = main ? main.ev_threshold : null;
    row.read_id = snapshotId([row.game_id, row.model_version, row.side, row.book, row.line, row.price, row.quote_observed_at, row.timing_read, row.decision_status, row.bettable_to_line, row.target_line]);
    return deepFreeze(row);
  }
  /* GRADING — against the close and the result, never a better historical line.
     ctx: { close_home_line, close_price_home, close_price_away, final_margin, later_quotes: [{home_line, price_home, price_away, observed_at}] } */
  function grade(row, g) {
    g = g || {};
    var out = { read_id: row.read_id, game_id: row.game_id, timing_read: row.timing_read, graded: false };
    if (!row.side || !isNum(row.line)) { out.reason = 'no side or line was recorded'; return out; }
    var sgn = row.side === 'home' ? 1 : -1;
    var closeSide = isNum(num(g.close_home_line)) ? sgn * num(g.close_home_line) : null;
    out.close_line = closeSide;
    out.clv_pts = isNum(closeSide) ? r(row.line - closeSide, 2) : null;
    out.positive_clv = isNum(out.clv_pts) ? out.clv_pts > 0 : null;
    /* the best later number on the side before kickoff (for WAIT / PRICE TARGET) */
    var later = (g.later_quotes || []).filter(function (q) { return ms(q.observed_at) > ms(row.recorded_at) && (!row.kickoff || ms(q.observed_at) < ms(row.kickoff)) && isNum(num(q.home_line)); })
      .map(function (q) { return sgn * num(q.home_line); });
    out.best_later_line = later.length ? Math.max.apply(null, later) : null;
    if (row.timing_read === 'PRICE_TARGET' || row.timing_read === 'WAIT') {
      out.target_reached = isNum(row.target_line) && isNum(out.best_later_line) ? out.best_later_line >= row.target_line - 1e-9 : null;
      out.wait_improvement_pts = isNum(out.best_later_line) ? r(out.best_later_line - row.line, 2) : null;
      out.close_vs_wait_price_pts = isNum(closeSide) ? r(closeSide - row.line, 2) : null;
      out.wait_success = isNum(out.close_vs_wait_price_pts) ? out.close_vs_wait_price_pts > 0 : null;
    }
    if (row.timing_read === 'BET_EARLY' || row.timing_read === 'BET') {
      out.later_worse = isNum(closeSide) ? closeSide < row.line : null;
      out.line_preserved_pts = isNum(closeSide) ? r(row.line - closeSide, 2) : null;
    }
    if (isNum(num(g.final_margin))) {
      var sm = sgn * num(g.final_margin), c = sm + row.line;
      out.result = c > 0 ? 'W' : (c < 0 ? 'L' : 'P');
      var pay = isNum(row.price) ? dec().americanToPayout(row.price) : null;
      out.units_at_recorded_price = isNum(pay) ? (out.result === 'W' ? r(pay, 4) : (out.result === 'L' ? -1 : 0)) : null;
      out.hypothetical = !(row.decision_status === 'BET' || row.decision_status === 'BET_EARLY');
      /* the alternates, at their own recorded numbers and prices */
      out.alt_results = (row.alt_rows || []).map(function (a) {
        var cc = sm + a.line, rr = cc > 0 ? 'W' : (cc < 0 ? 'L' : 'P'), pa = isNum(a.price) ? dec().americanToPayout(a.price) : null;
        return { label: a.label, verdict: a.verdict, result: rr, units: isNum(pa) ? (rr === 'W' ? r(pa, 4) : (rr === 'L' ? -1 : 0)) : null };
      });
    }
    out.graded = isNum(out.clv_pts) || !!out.result;
    out.process_grade = !isNum(out.clv_pts) ? 'NOT_GRADABLE' : (out.clv_pts > 0.5 ? 'GOOD_PRICE' : (out.clv_pts < -0.5 ? 'BAD_PRICE' : 'FAIR_PRICE'));
    return out;
  }
  /* THE VALIDATION DASHBOARD — timing earns validation through CLV and entry
     quality, never through wins alone. */
  function validation(rows, grades, minN) {
    minN = minN || 30;
    var byId = {};
    (grades || []).forEach(function (g) { byId[g.read_id] = g; });
    function mean(xs) { xs = xs.filter(isNum); return xs.length ? r(xs.reduce(function (a, b) { return a + b; }, 0) / xs.length, 3) : null; }
    function set(key) { return (rows || []).filter(function (x) { return x.timing_read === key; }); }
    function block(key, label) {
      var rs = set(key), gs = rs.map(function (x) { return byId[x.read_id]; }).filter(Boolean);
      var clv = gs.map(function (g) { return g.clv_pts; }).filter(isNum);
      var res = gs.filter(function (g) { return g.result === 'W' || g.result === 'L'; });
      return { key: key, label: label, n: rs.length, graded: gs.filter(function (g) { return g.graded; }).length, clv_n: clv.length, mean_clv_pts: mean(clv),
        positive_clv_rate: clv.length ? r(clv.filter(function (x) { return x > 0; }).length / clv.length, 3) : null,
        ats_n: res.length, ats_rate: res.length ? r(res.filter(function (g) { return g.result === 'W'; }).length / res.length, 3) : null,
        rates_shown: clv.length >= minN };
    }
    var waits = set('PRICE_TARGET').concat(set('WAIT')).map(function (x) { return byId[x.read_id]; }).filter(Boolean);
    var early = set('BET_EARLY').map(function (x) { return byId[x.read_id]; }).filter(Boolean);
    var alts = (rows || []).filter(function (x) { return x.alt_rows && x.alt_rows.length; });
    return {
      schema: 'edgedesk_read_validation_v1', min_n_for_rates: minN,
      bet_early: Object.assign(block('BET_EARLY', 'BET EARLY'), { later_worse_rate: early.length ? r(early.filter(function (g) { return g.later_worse; }).length / early.length, 3) : null,
        mean_line_preserved_pts: mean(early.map(function (g) { return g.line_preserved_pts; })) }),
      bet: block('BET', 'BET'),
      wait: Object.assign(block('PRICE_TARGET', 'WAIT FOR A NUMBER'), { n_all_waits: waits.length, mean_price_improvement_pts: mean(waits.map(function (g) { return g.wait_improvement_pts; })),
        target_reached_rate: waits.filter(function (g) { return g.target_reached != null; }).length ? r(waits.filter(function (g) { return g.target_reached; }).length / waits.filter(function (g) { return g.target_reached != null; }).length, 3) : null,
        wait_success_rate: waits.filter(function (g) { return g.wait_success != null; }).length ? r(waits.filter(function (g) { return g.wait_success; }).length / waits.filter(function (g) { return g.wait_success != null; }).length, 3) : null }),
      research: block('RESEARCH', 'RESEARCH ONLY'),
      pass: block('PASS', 'PASS (counterfactual)'),
      price_gone: block('PRICE_GONE', 'PRICE GONE (counterfactual)'),
      alternates: { n_reads_with_alts: alts.length, recommended_alt: alts.filter(function (x) { return x.best_value && x.best_value === x.best_alt; }).length },
      rule: 'Timing is validated only by CLV, entry quality and price movement on prospective reads — never because BET EARLY reads happened to win. Rates print at n ≥ ' + minN + '.'
    };
  }

  /* ========================================================= QUEUE FILTERS */
  var FILTERS = {
    best_value: { label: 'Best value', test: function (o) { return !!(o && o.best_value_market && o.best_value_market.type !== 'NONE' && !o.research_status.blocks_action); } },
    bet_early: { label: 'Bet early', test: function (o) { return !!o && o.timing_read === 'BET_EARLY'; } },
    wait: { label: 'Wait / price target', test: function (o) { return !!o && (o.timing_read === 'WAIT' || o.timing_read === 'PRICE_TARGET'); } },
    price_gone: { label: 'Price gone', test: function (o) { return !!o && (o.timing_read === 'PRICE_GONE' || (o.price_is_gone && o.price_is_gone.state === 'MOSTLY_GONE')); } },
    alt_value: { label: 'Alt value', test: function (o) { return !!(o && o.best_value_market && o.best_value_market.type === 'ALTERNATE_SPREAD'); } },
    overpriced_alt: { label: 'Overpriced alternates', test: function (o) { return !!(o && o.alternates && o.alternates.overpriced.length); } },
    high_agreement: { label: 'High model agreement', test: function (o) { return !!(o && o.model_agreement && o.model_agreement.label === 'STRONG'); } },
    verified_major: { label: 'Verified major', test: function (o) { return !!(o && o.research_status && o.research_status.status === 'VERIFIED_MAJOR_DISAGREEMENT'); } },
    investigate: { label: 'Investigate', test: function (o) { return !!o && o.timing_read === 'INVESTIGATE'; } },
    fresh_market: { label: 'Fresh market', test: function (o) { return !!(o && o.selected && o.selected.freshness === 'FRESH'); } },
    cleanest_price: { label: 'Cleanest price', test: function (o) { return isCleanestPrice(o); } }
  };
  /* CLEANEST PRICE: fresh market, reliable inputs, models agree, QB resolved,
     a positive EV after the buffer, and a reasonable (not suspicious) gap */
  function isCleanestPrice(o, cfg) {
    cfg = cfg || CONFIG;
    return !!(o && o.selected && o.selected.freshness === 'FRESH' && o.selected.clears
      && isNum(o.reliability) && o.reliability >= 80
      && o.model_agreement && (o.model_agreement.label === 'STRONG' || o.model_agreement.label === 'MODERATE')
      && o.qb_status && o.qb_status.resolved
      && o.model_market_gap && o.model_market_gap.points >= cfg.research_gap && o.model_market_gap.points < cfg.major_gap
      && !o.research_status.blocks_action);
  }
  /* research quality is ranked on its own — a 20-point unverified gap never outranks a clean 4-point price by size */
  function rankReads(list) {
    function q(o) {
      if (!o) return -1;
      var s = 0;
      if (o.research_status.blocks_action) s -= 50;
      if (isCleanestPrice(o)) s += 40;
      if (o.selected && o.selected.clears) s += 20;
      if (o.selected && o.selected.freshness === 'FRESH') s += 10;
      if (o.model_agreement && o.model_agreement.label === 'STRONG') s += 10;
      if (o.qb_status && o.qb_status.resolved) s += 5;
      if (o.research_status.status === 'VERIFIED_MAJOR_DISAGREEMENT') s += 10;
      if (isNum(o.ev_after_buffer)) s += clamp(o.ev_after_buffer * 100, -10, 10);
      else if (isNum(o.edge)) s += clamp(o.edge * 100, -10, 10);
      return s;
    }
    return (list || []).slice().sort(function (a, b) { return q(b) - q(a); });
  }

  /* ============================================== THE TERMINAL ADAPTER
     One function turns a stored research object (lib/cfb_terminal.js) and
     the stored read inputs (football/cfb_terminal/build.js) into a Read
     input. The build and the page both call it, so the Read a reader
     recomputes for another book is built exactly as the published one. */
  function fromTerminal(o, base, opts) {
    opts = opts || {};
    base = base || {};
    var A = o.edgedesk || {}, C = o.disagreement || {}, St = o.status || {}, lim = base.limits || { min_confidence: 35, low_reliability: 60 };
    var conf = A.available && A.football_confidence ? A.football_confidence.score : null, rel = o.data_quality ? o.data_quality.reliability : null;
    var limited = null;
    if (A.available && isNum(conf) && conf < lim.min_confidence) limited = 'football confidence ' + conf + ' is under the ' + lim.min_confidence + ' floor';
    else if (isNum(rel) && rel < lim.low_reliability) limited = 'reliability ' + rel + ' is under ' + lim.low_reliability;
    else if (o.market && o.market.stale) limited = 'only stale quotes are on file';
    var q = ((base.market && base.market.quotes) || []).slice();
    return {
      now: opts.now != null ? opts.now : base.now, game: { game_id: o.game_id, home: o.game.home, away: o.game.away, kickoff: o.kickoff, season: o.season, week: o.week },
      model: base.model || { available: !!A.available }, curve: base.curve || null, calibration: base.calibration || null, policy: base.policy || null,
      market: { quotes: q, open: base.market ? base.market.open : null, stored: base.market ? base.market.stored : [], moneyline: base.market ? base.market.moneyline : null },
      governed: base.governed || null, config: base.config || null,
      research: { status_key: St.key, reason: St.reason, fault: St.key === 'DATA_FAULT' ? St.reason : null, limited: limited,
        /* the ONE research status the terminal object carries (lib/edgedesk_canon.js researchStatusOfTerminal) */
        canonical: o.research_status && o.research_status.key ? { key: o.research_status.key, reason: o.research_status.reason || null, rule: o.research_status.rule || null } : null,
        disagreement: { class: C.class, points: C.points, verified: !!C.verified, verification: C.verification, toward: C.toward } },
      context: { qb: o.qb || null, agreement: o.consensus || null, risks: o.risks || null, reconcile: o.reconcile || null, why: o.why || null,
        edge_decay: o.edge_decay || null, key_mass: base.key_mass || null, expected_abs_error: base.expected_abs_error,
        reliability: rel, football_confidence: A.football_confidence || null },
      view: opts.view || { mode: 'best' }, user_quotes: opts.user_quotes || [], integrity: opts.integrity || null
    };
  }

  /* ========================================================== EXPORT */
  function exportRow(o) {
    return {
      game_id: o.game_id, kickoff: o.kickoff, home: o.home, away: o.away, model_version: o.model_version, generated_at: o.generated_at,
      fair_home_line: o.fair_spread ? o.fair_spread.home_line : null, market_home_line: o.market_consensus_spread ? o.market_consensus_spread.home_line : null,
      side: o.side_team, book: o.selected_book, line: o.selected_book_spread, price: o.selected_book_price,
      cover_probability: o.cover_probability, probability_basis: o.probability_basis, break_even: o.break_even_probability, estimated_ev: o.estimated_ev,
      bettable_to_line: o.bettable_to ? o.bettable_to.line : null, target_line: o.target_price ? o.target_price.line : null,
      timing_read: o.timing_read, decision_status: o.decision_status, research_status: o.research_status.status, price_status: o.price_status.key,
      best_value: o.main_vs_alt_summary.best_value, alt_verdict: o.main_vs_alt_summary.alt_verdict, calibration: o.calibration.status
    };
  }
  /* opts.decision: the page's one decision word (the canonical decision
     status), so a copied card never carries two decisions for one game */
  function exportText(o, opts) {
    var h = o.headline, dec = opts && opts.decision ? opts.decision : o.decision_status.replace(/_/g, ' ');
    return ['EDGEDESK READ · ' + o.away + ' @ ' + o.home,
      'Read: ' + h.read + ' (decision: ' + dec + ')',
      'Best value: ' + (h.best_value || '—'), 'Fair: ' + (h.fair || '—') + ' · Market: ' + (h.market || '—'),
      'Current: ' + (h.current || '—') + ' · Cushion ' + (h.cushion || '—'),
      'Cover ' + (h.cover || '—') + ' · Break-even ' + (h.break_even || '—') + ' · EV ' + (h.ev || '—'),
      'Bettable to: ' + h.bettable_to + (h.target ? ' · Target: ' + h.target : ''),
      'Price: ' + h.price_status + ' · ' + (h.market_trend || ''),
      'Alt: ' + (h.alt || '—'),
      'Research status: ' + h.research_status + ' · Calibration: ' + o.calibration.status,
      'Model ' + o.model_version + ' · built ' + o.generated_at,
      'Research, not advice: an edge is an expected value and any single game can lose.'].join('\n');
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, CONFIG: CONFIG, config: config, TIMING: TIMING, DECISION_OF_TIMING: DECISION_OF_TIMING, RESEARCH_STATUS: RESEARCH_STATUS,
    normalizePrice: normalizePrice, parsePrice: parsePrice, evOf: evOf, evFromCover: evFromCover, fairAmerican: fairAmerican,
    buildCurve: buildCurve, sideProb: sideProb, massAt: massAt,
    /* shared with lib/edgedesk_ev.js so the EV engine enumerates the same live quotes the Read prices */
    latestQuotes: latestQuotes, sidePriceOf: sidePriceOf, bookKey: bookKey,
    calibrationOf: calibrationOf, calibrate: calibrate,
    normalizeQuote: normalizeQuote, consensusOf: consensusOf, freshnessAudit: freshnessAudit, quoteAgeMinutes: quoteAgeMinutes,
    read: read, fromTerminal: fromTerminal, evaluateQuote: evaluateQuote, compare: compare, whatIf: whatIf, manual: manual, parseQuoteText: parseQuoteText,
    ask: ask, INTENTS: INTENTS, snapshot: snapshot, shouldRecord: shouldRecord, grade: grade, validation: validation,
    FILTERS: FILTERS, isCleanestPrice: isCleanestPrice, rankReads: rankReads, exportRow: exportRow, exportText: exportText,
    auditText: auditText, lineText: lineText, priceText: priceText
  };
}));

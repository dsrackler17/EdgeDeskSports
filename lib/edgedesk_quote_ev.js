/* ===========================================================================
   EDGEDESK QUOTE EV — expected value at an exact sportsbook quote.
   docs/edgedesk-ev/QUOTE_EV.md

   One question per quote: at THIS book's line AND price, what does EdgeDesk's
   own probability distribution say the wager is worth?

       PURE FOOTBALL MODEL          (fair margin + its outcome distribution)
         → P(win), P(push), P(loss) at the exact quoted line
         → the quote's own decimal price (same book, same capture)
         → break-even, probability edge, EV, fair price
         → availability gates, sanity guards
         → the decision layer (separately; never inherited by another quote)

   WHAT THIS FILE NEVER DOES
     - compute a football number. The distribution is handed in as a function
       of the home-margin threshold; this file only reads it.
     - let a price move a probability. A quote's odds enter the break-even and
       the payout, never the win/push/loss probabilities.
     - price one book's line with another book's price. A quote is priced only
       when its line and its price arrive on the same object.
     - assume −110, count a push as a win or a loss, or print 0% for an EV it
       could not compute (an unavailable EV is null with a reason).
     - invent a "best balance" score. None has been validated, so the ladder
       reports its dimensions separately (docs/edgedesk-ev/QUOTE_EV.md §7).

   DEFINITIONS (per $1 risked)
     decimal          American +A → 1 + A/100 ; −A → 1 + 100/A
     break-even       1 / decimal            (share of DECIDED bets that must win)
     cover            P(win) / (P(win) + P(loss))   — the no-push basis; equals
                      P(win) on a half-point line, where P(push) = 0
     probability edge cover − break-even     (same basis as break-even, so its
                      sign always equals the sign of EV)
     EV               P(win)·(decimal − 1) − P(loss)     (a push returns 0)
     fair decimal     (1 − P(push)) / P(win) = 1 / cover   (EV = 0 there)
     identity         EV = P(win) · (decimal − fair decimal)

   ODDS MATH is research_core's (EDResearch.americanToDecimal /
   decimalToAmerican / expectedRoi): the one tested implementation the rest of
   the terminal already uses. Parity with lib/edgedesk_ev.js and
   lib/edgedesk_read.js is pinned by tools/football/quote_ev.test.js.

   Browser: window.EDQuoteEV (load lib/research_core.js first).
   Node: require('./edgedesk_quote_ev.js'). ES5, no other dependencies.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDQuoteEV = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_quote_ev_v1';
  /* resolved at call time, by the collision-free name first: app.html's AI
     desk publishes a different window.EDResearch, so the core is only trusted
     when it actually carries the odds functions */
  var Rc = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) { try { Rc = require('./research_core.js'); } catch (e) { Rc = null; } }
  function R() {
    var c = Rc || (root && root.EDResearchCore) || (root && root.EDResearch && typeof root.EDResearch.americanToDecimal === 'function' ? root.EDResearch : null);
    if (!c || typeof c.americanToDecimal !== 'function') throw new Error('EDQuoteEV needs lib/research_core.js (EDResearchCore) loaded first');
    return c;
  }

  /* ------------------------------------------------------------- helpers */
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 6 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function halfPoint(x) { return isNum(x) && Math.abs(x * 2 - Math.round(x * 2)) < EPS; }
  function isInt(x) { return isNum(x) && Math.abs(x - Math.round(x)) < EPS; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  function pct(p, dp) { return isNum(p) ? (100 * p).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function signedPct(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function ppText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  /* FNV-1a: a stable id, browser and node alike */
  function hash(parts) {
    var s = typeof parts === 'string' ? parts : JSON.stringify(parts), h = 0x811c9dc5, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /* ================================================================= WORDS
     The tooltips the user sees, verbatim, one home. */
  var TOOLTIP = {
    ev: 'Expected value estimates the model’s expected profit or loss at this exact sportsbook line and price. It uses EdgeDesk’s model cover probability and the wager’s actual odds. EV is model-dependent and does not guarantee future profit.',
    model_ev: 'Expected value is calculated from EdgeDesk’s estimated probability and the exact available sportsbook price. It is an estimate, not guaranteed profit.',
    probability_edge: 'Model cover probability minus the probability required to break even at this price.',
    break_even: 'The percentage of bets that would need to win at these odds to avoid losing money over time.',
    cover: 'EdgeDesk’s probability that this side covers this exact line, read off its own outcome distribution. On a whole-number line pushes are excluded (a push returns the stake), so it is the share of decided bets the model expects to win.',
    push: 'The model’s probability the game lands exactly on this number, which returns the stake. Always 0 on a half-point line.',
    fair_odds: 'The price at which EdgeDesk’s probability makes this exact wager break even (EV = 0). Pushes are accounted for.',
    raw_ev: 'RAW EV: the arithmetic on EdgeDesk’s raw model probability at this exact price, with no calibration applied.',
    adjusted_ev: 'CALIBRATED EV: the same arithmetic on the probability after EdgeDesk’s validated calibration (the out-of-sample tournament, football/cfb_ev). Shown only where that calibration exists.',
    frontier: 'The value frontier: quotes that no other available quote beats on BOTH cover probability and EV. Every other quote is dominated.',
    dominated: 'Dominated: another available quote has at least this cover probability AND a higher EV.',
    max_ev: 'MAX EV: the largest raw mathematical expected value among available quotes. Not a recommendation — aggressive lines depend most on the distribution’s tails.',
    safest: 'SAFEST +EV: the highest model cover probability among available quotes that still show positive EV and are not blocked by a sanity guard.',
    main_line: 'MAIN LINE: the number most books are dealing for this side (the consensus main market).',
    key_number: 'The model’s probability mass on this exact final margin beside the league’s historical share of games decided by it. Crossing it is the protection an extra half point buys.',
    tail: 'Alternate lines far from the market line depend on the tails of the outcome distribution. Beyond the range EdgeDesk’s alternate-line audit validated, the EV is LOW CONFIDENCE.'
  };

  /* the reasons an EV is not shown, in the words the board prints after "EV unavailable · " */
  var UNAVAILABLE = {
    INVALID_GAME: 'game not valid',
    DATA_FAULT: 'DATA FAULT',
    NO_MODEL: 'model probability unavailable',
    MODEL_VERSION: 'model version unknown',
    ORIENTATION: 'spread orientation check failed',
    MARKET_INTEGRITY: 'market integrity check failed',
    NO_QUOTE: 'no priced quote',
    NO_LINE: 'no line on this quote',
    NO_PRICE: 'no price on this quote',
    INVALID_PRICE: 'not a valid sportsbook price',
    STALE: 'quote stale',
    QUOTE_TIME_UNKNOWN: 'quote capture time unknown',
    LINE_UNSUPPORTED: 'line outside the model distribution',
    DISTRIBUTION_FAULT: 'model distribution incoherent',
    CALIBRATION: 'probability calibration not validated',
    MARKET_UNSUPPORTED: 'market not supported'
  };

  /* ==================================================================== ODDS
     research_core's strict converters: an American price between −100 and
     +100 is not a price. A source that publishes only a decimal keeps that
     decimal at its own precision (a provider's 1.91 is not silently turned
     into −110), and its American display is marked approximate. */
  function americanToDecimal(a) { return R().americanToDecimal(a); }
  function decimalToAmerican(d) { return R().decimalToAmerican(d); }
  /* the whole-cent American price a decimal is displayed as */
  function americanDisplay(d) {
    var a = decimalToAmerican(d);
    if (!isNum(a)) return null;
    var x = Math.round(a);
    return x > -100 && x < 100 ? (x >= 0 ? 100 : -100) : x;
  }
  function breakEven(decimal) { return isNum(decimal) && decimal > 1 ? 1 / decimal : null; }
  /* win share of ALL outcomes needed when a push is possible */
  function breakEvenUnconditional(decimal, push) { var be = breakEven(decimal); return be == null ? null : (1 - (isNum(push) ? push : 0)) * be; }
  /* the price of one quote: American wins when both are present (it is the
     book's own number); a lone decimal is kept as published */
  function priceOf(american, decimal) {
    var a = num(american), d = num(decimal);
    var out = { valid: false, american: null, american_display: null, decimal: null, source: null, approximate_american: false, problem: null, mismatch: false };
    if (a != null) {
      var da = americanToDecimal(a);
      if (da == null) { out.problem = 'not an American price (' + a + ')'; return out; }
      if (Math.abs(a) > 20000) { out.problem = 'American price out of bounds (' + a + ')'; return out; }
      out.american = a; out.american_display = Math.round(a); out.decimal = da; out.source = 'AMERICAN';
      /* a decimal that travelled with it must describe the same price (to a provider's 2-dp rounding) */
      if (d != null && Math.abs(d - da) > 0.0051) out.mismatch = true;
    } else if (d != null) {
      if (!(d > 1.0001) || d > 201) { out.problem = 'decimal price out of bounds (' + d + ')'; return out; }
      out.decimal = d; out.american = decimalToAmerican(d); out.american_display = americanDisplay(d); out.source = 'DECIMAL';
      /* a provider's decimal is its book's American price rounded to 2 dp (−110 → 1.91): within that
         rounding the display is the book's own price; anything further is marked approximate */
      out.approximate_american = Math.abs(americanToDecimal(out.american_display) - d) > 0.0051;
    } else { out.problem = 'no price'; return out; }
    out.valid = true;
    return out;
  }
  /* F-EV: per $1 risked; fails closed on probabilities that do not form a distribution */
  function expectedValue(win, push, loss, decimal) {
    if (!isNum(win) || !isNum(decimal) || !(decimal > 1)) return null;
    var pu = isNum(push) ? push : 0, lo = isNum(loss) ? loss : 1 - win - pu;
    if (win < -EPS || pu < -EPS || lo < -EPS || win > 1 + EPS || Math.abs(win + pu + lo - 1) > 1e-6) return null;
    return win * (decimal - 1) - lo;
  }
  /* the decimal price at which the probabilities are exactly fair (push-aware) */
  function fairDecimal(win, push) { var pu = isNum(push) ? push : 0; return isNum(win) && win > 0 && pu < 1 ? (1 - pu) / win : null; }
  function fairAmerican(win, push) { var d = fairDecimal(win, push); return d == null ? null : americanDisplay(d); }
  /* cents between two American prices on the continuous −100/+100 scale:
     + = `to` pays more than `from` (−137 → −110 is +27) */
  function centsBetter(from, to) { var f = function (x) { return x < 0 ? x + 100 : x - 100; }; return isNum(from) && isNum(to) ? f(to) - f(from) : null; }

  /* ========================================================= PROBABILITIES
     The distribution arrives as homeCover(t): for a threshold t on the HOME
     margin (home score − away score), {win: P(M > t), push: P(M = t), lose}.
     That is the engines' own convention (football/engine.js and
     football/cfb_p4/engine.js coverProbSpread). A side's book line L maps to
     t = −L for home and t = L for away (the away side wins when M < L). */
  function sideProb(homeCover, side, line) {
    if (typeof homeCover !== 'function' || !isNum(line) || (side !== 'home' && side !== 'away')) return null;
    var c = null;
    try { c = homeCover(side === 'home' ? -line : line); } catch (e) { c = null; }
    if (!c || !isNum(c.win)) return null;
    var w = c.win, p = isNum(c.push) ? c.push : 0, l = isNum(c.lose) ? c.lose : (isNum(c.loss) ? c.loss : 1 - w - p);
    if (w < -EPS || p < -EPS || l < -EPS || Math.abs(w + p + l - 1) > 1e-6) return { fault: 'the distribution does not sum to 1 at this line' };
    w = Math.max(0, w); p = Math.max(0, p); l = Math.max(0, l);
    var out = side === 'home' ? { win: w, push: p, loss: l } : { win: l, push: p, loss: w };
    out.cover = out.win + out.loss > 0 ? out.win / (out.win + out.loss) : null;
    return out;
  }
  /* the probability a total goes over/under `line`, from totalCover(t) = {win: P(T > t), push, lose} */
  function totalProb(totalCover, side, line) {
    if (typeof totalCover !== 'function' || !isNum(line)) return null;
    var c = null; try { c = totalCover(line); } catch (e) { c = null; }
    if (!c || !isNum(c.win)) return null;
    var p = isNum(c.push) ? c.push : 0, l = isNum(c.lose) ? c.lose : 1 - c.win - p;
    var out = side === 'under' ? { win: l, push: p, loss: c.win } : { win: c.win, push: p, loss: l };
    out.cover = out.win + out.loss > 0 ? out.win / (out.win + out.loss) : null;
    return out;
  }

  /* THE CFB CHAMPION'S DISTRIBUTION FOR A PRICE LADDER.
     football/cfb_p4/engine.js coverProbSpread borrows its SHAPE from a table
     keyed by the market spread (the variable the table was built on) and
     re-centres it on EdgeDesk's pure fair margin. Keyed by each line in turn,
     every alternate would borrow a different shape and the ladder would not
     be one distribution. So the shape is conditioned ONCE, on the current
     market margin, and only the threshold moves; at threshold == that margin
     this reproduces the engine's own number exactly. The fair margin — the
     pure projection — is untouched; the market only chooses which empirical
     shape table the champion reads, as it always has.
     (Moved here from football/cfb_terminal/build.js v1CoverConditioned, which
     now calls this; parity pinned by tools/football/quote_ev.test.js.) */
  function pmfEntries(pmf) {
    var out = [], k;
    for (k in (pmf || {})) if (has(pmf, k)) out.push([parseInt(k, 10), pmf[k]]);
    return out.sort(function (a, b) { return a[0] - b[0]; });
  }
  function cfbConditionedCover(distributions, fair, condMargin, sigma, sigmaBase) {
    var D = distributions || {};
    var tab = D.margin_pmf_by_spread, rng = D.pmf_spread_range;
    if (num(condMargin) == null || num(fair) == null || !tab || !rng || condMargin < rng[0] || condMargin > rng[1]) return null;
    var key = (Math.round(condMargin * 2) / 2).toFixed(1);
    if (key === '-0.0') key = '0.0';
    var pmf = tab[key] || tab[Math.round(condMargin).toFixed(1)];
    if (!pmf) return null;
    var es = pmfEntries(pmf), em = 0, ew = 0;
    es.forEach(function (e) { em += e[0] * e[1]; ew += e[1]; });
    var shift = ew > 0 ? Math.round(fair - em / ew) : 0;
    var stretch = (num(sigma) && num(sigmaBase) && sigmaBase > 0) ? sigma / sigmaBase : 1;
    var pts = es.map(function (e) {
      var m = e[0] + shift, w = e[1];
      if (Math.abs(stretch - 1) >= 0.02) {
        var z0 = (m - fair) / (sigmaBase || 1), z1 = (m - fair) / (sigma || 1);
        w = e[1] * Math.exp(-0.5 * (z1 * z1 - z0 * z0)) / stretch;
      }
      return [m, w];
    });
    var tot = pts.reduce(function (s, x) { return s + x[1]; }, 0);
    if (!(tot > 0)) return null;
    return function (threshold) {
      var win = 0, push = 0;
      pts.forEach(function (x) { if (Math.abs(x[0] - threshold) < 1e-9) push += x[1]; else if (x[0] > threshold) win += x[1]; });
      return { win: win / tot, push: push / tot, lose: 1 - (win + push) / tot };
    };
  }

  /* ========================================================== TAIL DOMAIN
     How far from the market line the distribution has been VALIDATED for
     alternate lines. Read from the tournament's alternate-line audit
     (football/cfb_ev/artifacts/<v>/tournament.json alternate_line_domain):
     at each audited offset the calibrated (anchored) probability's slope must
     sit in the band lib/edgedesk_ev.js researchTriggers already treats as
     calibrated (0.6–1.6). The validated distance is the largest offset at
     which every audited offset up to it — on both sides — passes. Nothing
     here is tuned: no audit, no validated domain. */
  var SLOPE_BAND = [0.6, 1.6];
  function tailDomain(audit, band) {
    band = band || SLOPE_BAND;
    var rows = (audit || []).map(function (a) {
      var m = /^close_([mp])(\d+(?:\.\d+)?)$/.exec(String(a.checkpoint || ''));
      if (!m) return null;
      var s = a.anchored && isNum(a.anchored.slope) ? a.anchored.slope : null;
      return { offset: (m[1] === 'm' ? -1 : 1) * parseFloat(m[2]), n: a.n || null, slope: s, citl: a.anchored ? a.anchored.citl : null,
        pass: isNum(s) && s >= band[0] && s <= band[1] };
    }).filter(Boolean);
    if (!rows.length) return { validated_within_pts: 0, audited: [], basis: 'no alternate-line audit on file: every alternate away from the main line is outside the validated domain' };
    var dists = rows.map(function (x) { return Math.abs(x.offset); }).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort(function (a, b) { return a - b; });
    var ok = 0;
    for (var i = 0; i < dists.length; i++) {
      var at = rows.filter(function (x) { return Math.abs(Math.abs(x.offset) - dists[i]) < EPS; });
      if (at.every(function (x) { return x.pass; })) ok = dists[i]; else break;
    }
    return { validated_within_pts: ok, audited: rows, band: band.slice(),
      basis: 'alternate-line audit: calibrated slope inside ' + band[0] + '–' + band[1] + ' at every audited offset up to ±' + ok + ' pts'
        + (rows.some(function (x) { return !x.pass; }) ? '; failed at ' + rows.filter(function (x) { return !x.pass; }).map(function (x) { return (x.offset > 0 ? '+' : '') + x.offset + ' (slope ' + x.slope + ')'; }).join(', ') : '') };
  }

  /* ============================================================= THE QUOTE
     model = {
       sport, available, model_version, projection_timestamp, fair_home_margin,
       home_cover(t)              the RAW distribution (required for spreads)
       basis                      how that distribution was built (text)
       adjusted: { available, side_prob(side,line) → {win,push,loss}, label,
                   method, version, maturity, reason }   — optional; only a
                   VALIDATED calibration may supply it
       tail: { validated_within_pts, basis }
       key_mass: {3: .09, ...}    league share of |final margin| (history)
       total_cover(t), total_calibration: {validated, reason}
       moneyline: {home_win_prob, calibration: {validated, reason}}
     }
     quote = { game_id, side, team, market_type ('spread'|'alternate_spread'|
       'total'|'moneyline'), line, american, decimal, book, captured_at,
       fresh (bool, the page's own freshness verdict), freshness_state,
       is_main_line, provider_market_key, quote_id, n_books, line_book,
       price_book }
     ctx = { now, game: {game_id, home, away, kickoff}, research_status,
       data_fault, orientation: {ok, reason}, market_check_failed,
       main_line_for_side, qb_unresolved, reliability } */
  function baseLabel(q) {
    var t = q.team || q.side || '';
    if (q.market_type === 'total') return (q.side === 'under' ? 'Under ' : 'Over ') + (isNum(q.line) ? String(q.line) : '—');
    if (q.market_type === 'moneyline') return t + ' ML';
    return t + ' ' + lineText(q.line);
  }
  function unavailable(o, code, extra) {
    o.ev_available = false; o.ev_state = 'UNAVAILABLE'; o.ev_unavailable_code = code;
    o.ev_unavailable_reason = UNAVAILABLE[code] + (extra ? ' — ' + extra : '');
    o.expected_value = null; o.expected_value_pct = null;
    return o;
  }
  function priceQuote(model, quote, ctx) {
    model = model || {}; quote = quote || {}; ctx = ctx || {};
    var now = ms(ctx.now) != null ? ms(ctx.now) : Date.now();
    var mt = quote.market_type || 'spread', alt = mt === 'alternate_spread' || quote.is_main_line === false;
    var pr = priceOf(quote.american, quote.decimal);
    var line = num(quote.line);
    var o = {
      schema: VERSION,
      game_id: quote.game_id != null ? String(quote.game_id) : (ctx.game && ctx.game.game_id != null ? String(ctx.game.game_id) : null),
      sport: model.sport || null,
      team: quote.team || (ctx.game && quote.side === 'home' ? ctx.game.home || null : (ctx.game && quote.side === 'away' ? ctx.game.away || null : null)),
      side: quote.side || null, market_type: mt, is_main_line: !alt, off_market_main: !!quote.off_market_main,
      spread: mt === 'total' || mt === 'moneyline' ? null : line, line: line,
      american_odds: pr.valid ? pr.american_display : null, american_exact: pr.valid ? r(pr.american, 4) : null,
      decimal_odds: pr.valid ? r(pr.decimal, 6) : null, price_source: pr.source, approximate_american: pr.approximate_american,
      sportsbook: quote.book || null, quote_id: quote.quote_id || null, provider_market_key: quote.provider_market_key || null,
      line_book: quote.line_book || null, price_book: quote.price_book || null,
      n_books_at_line: num(quote.n_books),
      captured_at: iso(quote.captured_at), quote_age_minutes: null, quote_status: null,
      model_version: model.model_version || null, projection_timestamp: iso(model.projection_timestamp),
      model_win_probability: null, model_cover_probability: null, model_push_probability: null, model_loss_probability: null,
      break_even_probability: null, break_even_unconditional: null, probability_edge: null, probability_edge_pp: null,
      expected_value: null, expected_value_pct: null, model_fair_decimal: null, model_fair_odds: null, price_advantage_cents: null,
      adjusted: null, calibration_status: null, tail: null, key_numbers: [],
      ev_available: false, ev_state: 'UNAVAILABLE', ev_unavailable_code: null, ev_unavailable_reason: null,
      actionable_context: null, decision_status: null, decision_reason: null, flags: []
    };
    o.label = baseLabel(o) + (pr.valid ? ' (' + priceText(o.american_odds) + (pr.approximate_american ? '*' : '') + ')' : '');
    /* freshness is judged now, from the page's own verdict when it gave one */
    var at = ms(quote.captured_at);
    o.quote_age_minutes = at != null ? r(Math.max(0, (now - at) / 60000), 1) : null;
    o.quote_status = quote.freshness_state || (quote.fresh === true ? 'FRESH' : (quote.fresh === false ? 'STALE' : (at == null ? 'UNKNOWN' : null)));
    if (!o.quote_status && at != null && isNum(ctx.max_age_minutes)) o.quote_status = o.quote_age_minutes > ctx.max_age_minutes ? 'STALE' : 'FRESH';
    var fresh = quote.fresh === true || ((quote.fresh === undefined || quote.fresh === null) && o.quote_status === 'FRESH');

    /* ----- the gates, first failure wins (fail closed) ----- */
    if (!o.game_id) return unavailable(o, 'INVALID_GAME');
    if (ctx.data_fault || ctx.research_status === 'DATA_FAULT') return unavailable(o, 'DATA_FAULT', ctx.data_fault_reason || null);
    /* the decision engine (lib/edgedesk_decision.js) prices a total or a
       moneyline on the raw model probability and labels it MODEL-ESTIMATED;
       the board's own display keeps the calibration gate (ctx.decision_pricing unset) */
    if (mt === 'total' && !ctx.decision_pricing) {
      var tc = model.total_calibration || {};
      if (!tc.validated) return unavailable(o, 'CALIBRATION', tc.reason || 'no validated totals distribution');
    }
    if (mt === 'moneyline' && !ctx.decision_pricing) {
      var mc = (model.moneyline && model.moneyline.calibration) || {};
      if (!mc.validated) return unavailable(o, 'CALIBRATION', mc.reason || 'no validated win-probability calibration');
    }
    if (!model.available || (mt !== 'moneyline' && mt !== 'total' && typeof model.home_cover !== 'function')) return unavailable(o, 'NO_MODEL', model.reason || null);
    if (!model.model_version) return unavailable(o, 'MODEL_VERSION');
    if (ctx.orientation && ctx.orientation.ok === false) return unavailable(o, 'ORIENTATION', ctx.orientation.reason || null);
    if (ctx.market_check_failed) return unavailable(o, 'MARKET_INTEGRITY', ctx.market_check_reason || null);
    if (mt !== 'moneyline' && line == null) return unavailable(o, 'NO_LINE');
    if (!pr.valid) return unavailable(o, pr.problem === 'no price' ? 'NO_PRICE' : 'INVALID_PRICE', pr.problem === 'no price' ? null : pr.problem);
    if (o.quote_status === 'UNKNOWN' || (at == null && quote.fresh !== true)) return unavailable(o, 'QUOTE_TIME_UNKNOWN');
    if (!fresh) return unavailable(o, 'STALE', o.quote_age_minutes != null ? 'captured ' + Math.round(o.quote_age_minutes) + ' min ago' : null);
    if (mt !== 'moneyline' && !halfPoint(line)) return unavailable(o, 'LINE_UNSUPPORTED', 'a quarter line splits the stake; no distribution supports it');

    /* ----- the probability, from the model only ----- */
    var p = null;
    if (mt === 'total') p = totalProb(model.total_cover, quote.side, line);
    else if (mt === 'moneyline') {
      var hw = num(model.moneyline && model.moneyline.home_win_prob);
      p = hw == null ? null : (quote.side === 'home' ? { win: hw, push: 0, loss: 1 - hw } : { win: 1 - hw, push: 0, loss: hw });
      if (p) p.cover = p.win;
    } else p = sideProb(model.home_cover, quote.side, line);
    if (!p) return unavailable(o, 'LINE_UNSUPPORTED');
    if (p.fault) return unavailable(o, 'DISTRIBUTION_FAULT', p.fault);
    var d = pr.decimal;
    o.model_win_probability = r(p.win); o.model_push_probability = r(p.push); o.model_loss_probability = r(p.loss);
    o.model_cover_probability = r(p.cover);
    o.break_even_probability = r(breakEven(d)); o.break_even_unconditional = r(breakEvenUnconditional(d, p.push));
    o.probability_edge = isNum(p.cover) ? r(p.cover - 1 / d) : null;
    o.probability_edge_pp = isNum(o.probability_edge) ? r(100 * o.probability_edge, 3) : null;
    var ev = expectedValue(p.win, p.push, p.loss, d);
    if (!isNum(ev)) return unavailable(o, 'DISTRIBUTION_FAULT', 'win + push + loss must equal 1');
    o.expected_value = r(ev); o.expected_value_pct = r(100 * ev, 3);
    var fd = fairDecimal(p.win, p.push);
    o.model_fair_decimal = r(fd); o.model_fair_odds = fd ? americanDisplay(fd) : null;
    o.price_advantage_cents = isNum(o.model_fair_odds) ? r(centsBetter(o.model_fair_odds, o.american_odds), 1) : null;
    o.ev_available = true; o.ev_state = 'AVAILABLE';

    /* ----- the validated (uncertainty-adjusted) probability, only where one exists ----- */
    var A = model.adjusted;
    if (mt === 'total' || mt === 'moneyline') o.adjusted = null;
    else if (A && A.available && typeof A.side_prob === 'function') {
      var q = null; try { q = A.side_prob(quote.side, line); } catch (e) { q = null; }
      if (q && isNum(q.win)) {
        var qp = isNum(q.push) ? q.push : 0, ql = isNum(q.loss) ? q.loss : 1 - q.win - qp, qc = q.win + ql > 0 ? q.win / (q.win + ql) : null;
        var aev = expectedValue(q.win, qp, ql, d);
        o.adjusted = { available: isNum(aev), label: A.label || 'CALIBRATED', method: A.method || null, version: A.version || null, maturity: A.maturity || null,
          model_win_probability: r(q.win), model_cover_probability: r(qc), model_push_probability: r(qp), model_loss_probability: r(ql),
          probability_edge: isNum(qc) ? r(qc - 1 / d) : null, expected_value: r(aev), expected_value_pct: isNum(aev) ? r(100 * aev, 3) : null,
          model_fair_odds: fairAmerican(q.win, qp), reason: null };
      } else o.adjusted = { available: false, reason: 'the calibrated distribution does not reach this line' };
    } else o.adjusted = { available: false, reason: (A && A.reason) || 'no validated probability calibration exists for this market — RAW EV only' };
    o.calibration_status = A && A.available ? (A.label || 'CALIBRATED') + (A.maturity ? ' · ' + A.maturity : '') : 'RAW ONLY';

    /* ----- tails and key numbers (spreads) ----- */
    if (mt !== 'total' && mt !== 'moneyline') {
      var ml = num(ctx.main_line_for_side), T = model.tail || {};
      var dist = isNum(ml) ? r(Math.abs(line - ml), 2) : null;
      var within = num(T.validated_within_pts);
      o.tail = { distance_from_main_pts: dist, validated_within_pts: within,
        status: dist == null ? 'UNKNOWN' : (dist < EPS ? 'MAIN_LINE' : (isNum(within) && dist <= within + EPS ? 'VALIDATED' : 'NOT_VALIDATED')),
        basis: T.basis || null };
      if (o.tail.status === 'NOT_VALIDATED') { o.tail.label = 'LOW CONFIDENCE · TAIL CALIBRATION NOT VALIDATED'; }
      if (isNum(ml) && Math.abs(line - ml) > EPS) o.key_numbers = keysBetween(model, quote.side, ml, line);
    }

    /* ----- research status: raw EV kept, but never dressed as a signal ----- */
    var rs = ctx.research_status || null;
    if (rs === 'INVESTIGATE') { o.ev_state = 'RAW_UNVERIFIED'; o.actionable_context = 'RAW PRICE EV · INTEGRITY CHECK NOT CLEARED'; }
    else if (rs === 'MARKET_FAULT') { o.ev_state = 'AUDIT_ONLY'; o.actionable_context = 'AUDIT ONLY · MARKET FAULT · not currently actionable'; }

    o.flags = sanity(o, ctx);
    return o;
  }

  /* the integers a move from line a to line b (for one side) lands on or
     crosses, each with THIS game's model mass there and the league's history */
  function keysBetween(model, side, a, b) {
    var lo = Math.min(a, b), hi = Math.max(a, b), out = [], k;
    var KN = (R().KEY_NUMBERS || {})[String(model.sport || '').toUpperCase() === 'NFL' ? 'NFL' : 'CFB'] || { primary: [3, 7], secondary: [] };
    for (k = Math.ceil(lo - EPS); k <= Math.floor(hi + EPS); k++) {
      if (k === 0) continue;
      /* the side LOSES by k when k > 0 (a +k line pushes there) and wins by |k| when k < 0 */
      var pk = sideProb(model.home_cover, side, k), ak = Math.abs(k);
      out.push({ margin_for_side: -k, abs_margin: ak, model_mass: pk && !pk.fault ? r(pk.push, 5) : null,
        historical_share: model.key_mass && isNum(num(model.key_mass[ak])) ? num(model.key_mass[ak]) : null,
        key: KN.primary.indexOf(ak) >= 0 ? 'primary' : (KN.secondary.indexOf(ak) >= 0 ? 'secondary' : null) });
    }
    return out;
  }

  /* ============================================================== SANITY
     These never delete an EV; they raise the flag a person reads first. */
  var LARGE_EV = 0.10;                 /* PRESENTATION: an EV this large is reviewed before it is read */
  function flag(list, code, text, severity) { list.push({ code: code, text: text, severity: severity || 'REVIEW' }); }
  function sanity(o, ctx) {
    var f = [];
    if (!o.ev_available) return f;
    var ev = o.expected_value, alt = !o.is_main_line;
    if (ev > 0.25) flag(f, 'EV_OVER_25', 'EV above +25% (' + signedPct(ev) + '): verify the quote and the orientation before reading it', 'HIGH');
    if (ev < -0.50) flag(f, 'EV_UNDER_NEG_50', 'EV below −50% (' + signedPct(ev) + '): the quote or the side is probably mis-read', 'HIGH');
    if (alt && ev > 0.35) flag(f, 'ALT_EV_OVER_35', 'an ordinary alternate at ' + signedPct(ev) + ' EV — tails decide this number', 'HIGH');
    if (!alt && o.market_type !== 'moneyline' && isNum(o.model_cover_probability) && o.model_cover_probability > 0.75) flag(f, 'COVER_OVER_75', 'model cover ' + pct(o.model_cover_probability) + ' on a main spread');
    if (ev >= LARGE_EV) {
      if (isNum(ctx.reliability) && ctx.reliability < 60) flag(f, 'LARGE_EV_LOW_RELIABILITY', 'large EV on reliability ' + Math.round(ctx.reliability));
      if (ctx.qb_unresolved) flag(f, 'LARGE_EV_QB_UNRESOLVED', 'large EV while a starting quarterback is unresolved');
      if (ctx.market_stale) flag(f, 'LARGE_EV_STALE_MARKET', 'large EV while the board market is stale');
      if (ctx.research_status === 'MARKET_FAULT') flag(f, 'LARGE_EV_MARKET_FAULT', 'large EV on a MARKET FAULT game', 'HIGH');
    }
    /* the arithmetic, re-derived independently of the path that produced it */
    var d2 = isNum(o.american_exact) && o.price_source === 'AMERICAN' ? americanToDecimal(o.american_exact) : o.decimal_odds;
    if (!isNum(d2) || Math.abs(1 / d2 - o.break_even_probability) > 1e-6) flag(f, 'BREAK_EVEN_MISMATCH', 'break-even does not equal 1 / decimal', 'HIGH');
    var ev2 = R().expectedRoi(o.model_win_probability, isNum(o.american_exact) ? o.american_exact : o.american_odds, o.model_push_probability);
    if (o.price_source === 'AMERICAN' && isNum(ev2) && Math.abs(ev2 - ev) > 1e-5) flag(f, 'EV_INCONSISTENT', 'EV disagrees with research_core expectedRoi', 'HIGH');
    if (isNum(o.probability_edge) && Math.abs(ev) > 1e-6 && (ev > 0) !== (o.probability_edge > 0)) flag(f, 'EV_EDGE_SIGN', 'EV and probability edge disagree in sign', 'HIGH');
    if (o.line_book && o.price_book && o.line_book !== o.price_book) flag(f, 'BOOK_MISMATCH', 'the line and the price came from different books', 'HIGH');
    if (o.market_type !== 'moneyline' && isNum(o.line)) {
      if (!isInt(o.line) && o.model_push_probability > 1e-9) flag(f, 'UNEXPECTED_PUSH', 'a half-point line carries push probability', 'HIGH');
      if (isInt(o.line) && o.market_type !== 'total' && !(o.model_push_probability > 0)) flag(f, 'INTEGER_PUSH_MISSING', 'a whole-number line with no push probability', 'HIGH');
    }
    if (o.tail && o.tail.status === 'NOT_VALIDATED') flag(f, 'TAIL_UNVALIDATED', o.tail.label);
    if (ctx.orientation_warning) flag(f, 'ORIENTATION_MISMATCH', ctx.orientation_warning, 'HIGH');
    /* the quote's side came from its team name, so it is priced; the market
       NUMBER only reconciles with the model once negated, which is a reason to
       verify, never a reason to hide the arithmetic (lib/edgedesk_decision.js
       reviews it as a price anomaly) */
    if (ctx.sign_suspect) flag(f, 'SIGN_SUSPECT', 'the market number only agrees with the model once its sign is flipped: ' + (ctx.sign_suspect.reason || 'verify the orientation') + ' — a price anomaly until verified', 'HIGH');
    return f;
  }

  /* ============================================================ THE GAME
     Every valid quote on both sides, priced one by one; then per side the
     BEST LINE (most points among main-market quotes, price breaks ties), the
     BEST PRICE (best odds at the side's main line) and the BEST EV (highest
     EV among main-market quotes). They can be three different quotes. */
  function mainLineOf(quotes, side) {
    var by = {};
    quotes.forEach(function (q) {
      if (q.side !== side || q.market_type === 'alternate_spread' || q.is_main_line === false || !isNum(num(q.line))) return;
      var k = String(num(q.line));
      by[k] = (by[k] || 0) + (num(q.n_books) || 1);
    });
    var ks = Object.keys(by);
    if (!ks.length) return null;
    var lines = ks.map(Number).sort(function (a, b) { return a - b; }), med = lines[Math.floor((lines.length - 1) / 2)];
    ks.sort(function (a, b) { return (by[b] - by[a]) || (Math.abs(Number(a) - med) - Math.abs(Number(b) - med)) || (Number(a) - Number(b)); });
    return Number(ks[0]);
  }
  /* A "spreads" row far from its side's consensus main line is not a main
     line, whatever its market key says: the captured board keeps one row per
     number it has seen (a moved book's old number, an off-market provider
     row). Such a row is priced as an ALTERNATE — tail-checked, never the
     side's BEST LINE / BEST PRICE / BEST EV — so +28.5 (-10000) cannot win a
     "best available" field. */
  var MAIN_BAND_PTS = { NFL: 2.5, CFB: 3.5 };
  function mainBandPts(model) { return String(model && model.sport || '').toUpperCase() === 'NFL' ? MAIN_BAND_PTS.NFL : MAIN_BAND_PTS.CFB; }
  function betterQuote(a, b) {                     /* is a a better number than b for the taker? */
    if (!b) return true;
    if (a.line !== b.line) return a.line > b.line;
    return (a.decimal_odds || 0) > (b.decimal_odds || 0);
  }
  function evaluateGame(model, quotes, ctx) {
    ctx = ctx || {};
    var game = ctx.game || {};
    /* spreads only here: a total or a moneyline is priced by otherMarkets() */
    var list = (quotes || []).filter(function (x) { return x && (!x.market_type || x.market_type === 'spread' || x.market_type === 'alternate_spread'); });
    var mains = { home: mainLineOf(list, 'home'), away: mainLineOf(list, 'away') }, band = mainBandPts(model);
    list = list.map(function (q) {
      var ln = num(q.line), ml = mains[q.side];
      if ((q.market_type || 'spread') !== 'spread' || q.is_main_line === false || !isNum(ln) || !isNum(ml) || Math.abs(ln - ml) <= band + EPS) return q;
      return Object.assign({}, q, { is_main_line: false, off_market_main: true });
    });
    var out = { schema: VERSION, game_id: game.game_id != null ? String(game.game_id) : null, sport: model && model.sport || null,
      model_version: model && model.model_version || null, projection_timestamp: iso(model && model.projection_timestamp), evaluated_at: iso(ctx.now || Date.now()),
      main_line: mains, sides: {}, flags: [], n_quotes: list.length };
    ['home', 'away'].forEach(function (s) {
      var team = s === 'home' ? game.home : game.away;
      var priced = list.filter(function (q) { return q.side === s; }).map(function (q) {
        var qq = Object.assign({}, q, { team: q.team || team, game_id: q.game_id != null ? q.game_id : game.game_id });
        var c2 = Object.assign({}, ctx, { main_line_for_side: mains[s] });
        return priceQuote(model, qq, c2);
      });
      var avail = priced.filter(function (o) { return o.ev_available; });
      var mainMkt = avail.filter(function (o) { return o.is_main_line; });
      var bestLine = null, bestPrice = null, bestEv = null;
      mainMkt.forEach(function (o) { if (betterQuote(o, bestLine)) bestLine = o; });
      mainMkt.filter(function (o) { return isNum(mains[s]) && Math.abs(o.line - mains[s]) < EPS; })
        .forEach(function (o) { if (!bestPrice || o.decimal_odds > bestPrice.decimal_odds) bestPrice = o; });
      mainMkt.forEach(function (o) { if (!bestEv || o.expected_value > bestEv.expected_value + EPS || (Math.abs(o.expected_value - bestEv.expected_value) <= EPS && betterQuote(o, bestEv))) bestEv = o; });
      out.sides[s] = { side: s, team: team, main_line: mains[s], quotes: priced, n_available: avail.length,
        best_line: bestLine, best_price: bestPrice, best_ev: bestEv, ladder: ladder(priced, { main_line: mains[s], model: model, side: s }),
        unavailable: summarizeUnavailable(priced) };
    });
    /* the headline quote: the best main-market EV across BOTH sides (never only the model's lean) */
    var h = out.sides.home.best_ev, a = out.sides.away.best_ev;
    var best = !h ? a : (!a ? h : (a.expected_value > h.expected_value ? a : h));
    out.best_ev_quote = best || null;
    out.best_ev_pct = best ? best.expected_value_pct : null;
    out.best_ev_book = best ? best.sportsbook : null;
    out.best_ev_spread = best ? best.line : null;
    out.best_ev_odds = best ? best.american_odds : null;
    out.ev_available = !!best;
    out.ev_unavailable_reason = best ? null : firstReason(out);
    out.flags = gameFlags(out, ctx);
    return out;
  }
  /* totals and moneylines: priced through the same gates, each market's
     calibration deciding whether a number is shown at all */
  function otherMarkets(model, quotes, ctx) {
    var game = (ctx && ctx.game) || {};
    function one(mt) {
      var qs = (quotes || []).filter(function (x) { return x && x.market_type === mt; }).map(function (x) {
        var team = x.side === 'home' ? game.home : (x.side === 'away' ? game.away : null);
        return priceQuote(model, Object.assign({}, x, { team: x.team || team, game_id: x.game_id != null ? x.game_id : game.game_id }), ctx);
      });
      var av = qs.filter(function (o) { return o.ev_available; }).sort(function (a, b) { return b.expected_value - a.expected_value; });
      var cal = mt === 'total' ? (model && model.total_calibration) || {} : ((model && model.moneyline && model.moneyline.calibration) || {});
      return { market_type: mt, quotes: qs, best_ev: av[0] || null, validated: !!cal.validated,
        unavailable_reason: av.length ? null : (qs.length ? qs[0].ev_unavailable_reason : (cal.validated ? UNAVAILABLE.NO_QUOTE : UNAVAILABLE.CALIBRATION + (cal.reason ? ' — ' + cal.reason : ''))) };
    }
    return { total: one('total'), moneyline: one('moneyline') };
  }
  function summarizeUnavailable(priced) {
    var by = {};
    priced.filter(function (o) { return !o.ev_available; }).forEach(function (o) { by[o.ev_unavailable_code] = (by[o.ev_unavailable_code] || 0) + 1; });
    return by;
  }
  /* why a game shows "EV —": the most specific reason among its quotes */
  var REASON_ORDER = ['DATA_FAULT', 'INVALID_GAME', 'NO_MODEL', 'MODEL_VERSION', 'ORIENTATION', 'MARKET_INTEGRITY', 'DISTRIBUTION_FAULT', 'STALE', 'QUOTE_TIME_UNKNOWN', 'NO_PRICE', 'INVALID_PRICE', 'LINE_UNSUPPORTED', 'NO_LINE'];
  function firstReason(g) {
    var all = (g.sides.home ? g.sides.home.quotes : []).concat(g.sides.away ? g.sides.away.quotes : []);
    if (!all.length) return UNAVAILABLE.NO_QUOTE;
    for (var i = 0; i < REASON_ORDER.length; i++) {
      var hit = all.filter(function (o) { return o.ev_unavailable_code === REASON_ORDER[i]; })[0];
      if (hit) return hit.ev_unavailable_reason;
    }
    return UNAVAILABLE.NO_QUOTE;
  }
  /* two sides of the same number cannot both be good bets unless the books let
     you middle or arbitrage them; anything else points at a probability or
     orientation bug */
  function gameFlags(g, ctx) {
    var f = [], H = g.sides.home, A = g.sides.away;
    var hq = (H ? H.quotes : []).filter(function (o) { return o.ev_available; }), aq = (A ? A.quotes : []).filter(function (o) { return o.ev_available; });
    hq.forEach(function (h) {
      aq.forEach(function (a) {
        if (!(h.expected_value > 0 && a.expected_value > 0)) return;
        var sum = h.line + a.line;                         /* home +x and away +y: x + y > 0 leaves a middle */
        var arb = 1 / h.decimal_odds + 1 / a.decimal_odds < 1;
        if (Math.abs(sum) < EPS && !arb) flag(f, 'BOTH_SIDES_POSITIVE', 'both ' + h.label + ' and ' + a.label + ' show positive EV at the same number — check the distribution and the orientation', 'HIGH');
        else if (Math.abs(sum) < EPS && arb) flag(f, 'ARBITRAGE_CONDITION', h.label + ' (' + h.sportsbook + ') and ' + a.label + ' (' + a.sportsbook + ') price below 100% combined: an arbitrage condition, not a model edge');
      });
    });
    /* the main lines of the two sides must be the same number with opposite signs */
    if (isNum(g.main_line.home) && isNum(g.main_line.away) && Math.abs(g.main_line.home + g.main_line.away) > 1 + EPS)
      flag(f, 'ORIENTATION_MISMATCH', 'the main lines do not mirror (home ' + lineText(g.main_line.home) + ', away ' + lineText(g.main_line.away) + '): check the side mapping', 'HIGH');
    ['home', 'away'].forEach(function (s) {
      var L = g.sides[s] && g.sides[s].ladder;
      if (L) L.flags.forEach(function (x) { f.push(x); });
    });
    return f;
  }

  /* ============================================================ THE LADDER
     Every available quote on one side (main and alternate). For each spread
     the best price is the priced row; every other quote at that spread stays
     for audit. Then:
       frontier    quotes not dominated on (cover, EV)
       MAX EV      the largest raw EV
       SAFEST +EV  the highest cover among positive-EV quotes no HIGH sanity
                   flag blocks
       MAIN LINE   the best-price quote at the consensus main line
       steps       adjacent spreads, safest → most aggressive: the extra cover,
                   the extra cost (break-even, cents), the EV change and the
                   key numbers in between
     No BEST BALANCE: EdgeDesk has no validated rule to combine these. */
  function dominated(a, b) {                       /* is a dominated by b? */
    return b !== a && b.model_cover_probability >= a.model_cover_probability - EPS && b.expected_value > a.expected_value + 1e-9;
  }
  function ladder(priced, opts) {
    opts = opts || {};
    var avail = priced.filter(function (o) { return o.ev_available; });
    var bySpread = {};
    avail.forEach(function (o) { var k = String(o.line); (bySpread[k] = bySpread[k] || []).push(o); });
    var rows = Object.keys(bySpread).map(function (k) {
      var qs = bySpread[k].slice().sort(function (a, b) { return (b.decimal_odds - a.decimal_odds) || String(a.sportsbook).localeCompare(String(b.sportsbook)); });
      return { spread: Number(k), best: qs[0], quotes: qs, n_books: qs.length, is_main_line: isNum(opts.main_line) && Math.abs(Number(k) - opts.main_line) < EPS };
    }).sort(function (a, b) { return b.spread - a.spread; });           /* safest (most points) first */
    avail.forEach(function (o) { o.dominated = avail.some(function (b) { return dominated(o, b); }); });
    var frontier = avail.filter(function (o) { return !o.dominated; }).sort(function (a, b) { return b.line - a.line || b.decimal_odds - a.decimal_odds; });
    var clean = function (o) { return !(o.flags || []).some(function (x) { return x.severity === 'HIGH'; }); };
    var maxEv = avail.slice().sort(function (a, b) { return (b.expected_value - a.expected_value) || (b.line - a.line); })[0] || null;
    var safest = avail.filter(function (o) { return o.expected_value > 0 && clean(o) && o.tail && o.tail.status !== 'NOT_VALIDATED'; })
      .sort(function (a, b) { return (b.model_cover_probability - a.model_cover_probability) || (b.expected_value - a.expected_value); })[0] || null;
    /* the same question with no guard applied: shown only as an unvalidated candidate, with its reasons */
    var safestAny = avail.filter(function (o) { return o.expected_value > 0; })
      .sort(function (a, b) { return (b.model_cover_probability - a.model_cover_probability) || (b.expected_value - a.expected_value); })[0] || null;
    var main = rows.filter(function (x) { return x.is_main_line; })[0];
    var steps = [];
    for (var i = 1; i < rows.length; i++) {
      var A = rows[i - 1].best, B = rows[i].best;       /* A = more points (safer), B = fewer points */
      steps.push({ from: A.label, to: B.label, from_book: A.sportsbook, to_book: B.sportsbook,
        from_line: A.line, from_odds: A.american_odds, to_line: B.line, to_odds: B.american_odds,
        points: r(A.line - B.line, 2),
        cover_gain_pp: r(100 * (A.model_cover_probability - B.model_cover_probability), 2),       /* what the extra points buy */
        break_even_cost_pp: r(100 * (A.break_even_probability - B.break_even_probability), 2),   /* what they cost in required win rate */
        juice_cents: centsBetter(A.american_odds, B.american_odds),                                  /* + = the safer line charges more */
        ev_change_pct: r(100 * (A.expected_value - B.expected_value), 3),                          /* EV of the safer line minus the aggressive one */
        protection_value_pp: r(100 * ((A.model_cover_probability - B.model_cover_probability) - (A.break_even_probability - B.break_even_probability)), 2),
        push_change_pp: r(100 * ((A.model_push_probability || 0) - (B.model_push_probability || 0)), 2),   /* a whole number adds a push, which returns the stake */
        protection_worth_it: A.expected_value > B.expected_value,                                          /* judged by EV, which counts the push */
        key_numbers: keysBetween(opts.model || {}, A.side, B.line, A.line).filter(function (k) { return k.abs_margin !== 0; }),
        text: stepText(A, B) });
    }
    var flags = ladderFlags(rows, avail, priced);
    return { side: opts.side || null, main_line: isNum(opts.main_line) ? opts.main_line : null, rows: rows, frontier: frontier,
      n_quotes: avail.length, n_spreads: rows.length, n_dominated: avail.filter(function (o) { return o.dominated; }).length,
      max_ev: maxEv, safest_positive_ev: safest, safest_positive_ev_any: safestAny, main: main ? main.best : null,
      best_balance: null, best_balance_note: 'No validated rule exists to combine EV, cover probability, price and protection into one "best balance" score, so none is shown. Compare the frontier.',
      steps: steps, flags: flags };
  }
  /* the verdict follows the EV change, not cover alone: EV counts the push a
     whole number adds (the stake comes back), the no-push cover share does not */
  function stepText(A, B) {
    var gain = A.model_cover_probability - B.model_cover_probability, cost = A.break_even_probability - B.break_even_probability, dEv = A.expected_value - B.expected_value;
    var dPush = (A.model_push_probability || 0) - (B.model_push_probability || 0);
    var cents = centsBetter(A.american_odds, B.american_odds);
    return 'Buying ' + lineText(B.line) + ' → ' + lineText(A.line) + ': ' + ppText(gain) + ' cover protection'
      + (Math.abs(dPush) >= 0.0005 ? (dPush > 0 ? ' plus ' : ' less ') + (100 * Math.abs(dPush)).toFixed(1) + ' pp push' : '')
      + (isNum(cents) ? ' costs ' + Math.abs(Math.round(cents)) + ' cents of juice' + (cents < 0 ? ' (the safer price is better)' : '') : '')
      + ' (' + ppText(cost) + ' break-even); EV ' + (dEv >= 0 ? 'rises ' : 'falls ') + Math.abs(100 * dEv).toFixed(1) + ' points'
      + (dEv > 1e-9 ? ' — the protection is priced below its model value.' : (dEv < -1e-9 ? ' — the protection costs more than the model says it is worth.' : ' — the protection is priced at its model value.'));
  }
  function ladderFlags(rows, avail, priced) {
    var f = [];
    /* cover must rise with the points; the model cannot disagree with itself at one spread */
    for (var i = 1; i < rows.length; i++) {
      if (rows[i].best.model_cover_probability > rows[i - 1].best.model_cover_probability + 1e-9)
        flag(f, 'COVER_NON_MONOTONE', 'cover probability rises from ' + rows[i - 1].best.label + ' to ' + rows[i].best.label + ' although the line got worse', 'HIGH');
      var jump = Math.abs(rows[i].best.expected_value - rows[i - 1].best.expected_value);
      if (Math.abs(rows[i].spread - rows[i - 1].spread) <= 0.5 + EPS && jump >= LARGE_EV)
        flag(f, 'ALT_DISCONTINUITY', 'EV jumps ' + (100 * jump).toFixed(1) + ' points between adjacent half points ' + rows[i - 1].best.label + ' and ' + rows[i].best.label + ': check both prices');
    }
    rows.forEach(function (row) {
      var ps = row.quotes.map(function (q) { return q.model_cover_probability; });
      if (Math.max.apply(null, ps) - Math.min.apply(null, ps) > 1e-9) flag(f, 'CONTRADICTORY_PROBABILITY', 'two quotes at ' + lineText(row.spread) + ' carry different model probabilities', 'HIGH');
    });
    /* a book offering a better spread AND better odds than another book's quote */
    avail.forEach(function (a) {
      var b = avail.filter(function (x) { return x !== a && x.sportsbook !== a.sportsbook && x.line > a.line + EPS && x.decimal_odds >= a.decimal_odds - EPS; })[0];
      if (b && a.is_main_line && b.is_main_line) flag(f, 'BETTER_LINE_AND_PRICE_ELSEWHERE', b.label + ' at ' + b.sportsbook + ' beats ' + a.label + ' at ' + a.sportsbook + ' on both the number and the price');
    });
    /* the best-EV quote on file (stale included) is not a current price */
    /* a stale quote has no EV, so the comparison is on price at the same spread */
    priced.filter(function (o) { return isNum(o.decimal_odds) && o.ev_unavailable_code === 'STALE'; }).forEach(function (s) {
      var at = avail.filter(function (o) { return Math.abs(o.line - s.line) < EPS; })[0];
      if (at && s.decimal_odds > at.decimal_odds + EPS) flag(f, 'STALE_BETTER_PRICE', s.label + ' at ' + s.sportsbook + ' was better but is stale — it is not an available price');
    });
    avail.forEach(function (o) {
      if (!o.is_main_line && (Math.abs(o.american_odds) > 1500 || (o.tail && isNum(o.tail.distance_from_main_pts) && o.tail.distance_from_main_pts > 21)))
        flag(f, 'ALT_IMPLAUSIBLE', o.label + ' is outside the plausible alternate range (±21 pts from the main line, |price| ≤ 1500)');
    });
    return f;
  }

  /* =========================================================== DECISION
     A quote's decision is its own. The formal decision engine speaks for the
     game (the quote it evaluated); every other quote — an alternate, another
     book — is priced but NOT decided, and never inherits that verdict.
     decisionFor(o, d): d = {status, reason, evaluated_quote: {line, book, side},
     requires} from the decision layer. */
  function decisionFor(o, d) {
    d = d || {};
    if (!o) return { status: 'NO_DECISION', reason: 'no quote' };
    if (!o.ev_available) return { status: 'NO_DECISION', reason: 'EV unavailable · ' + o.ev_unavailable_reason, evaluated: false };
    var ev = d.evaluated_quote || null;
    /* the same exact quote: side, line, book and (when both are known) price;
       a re-priced number is another quote and inherits nothing */
    var same = ev && ev.side && String(ev.side).toLowerCase() === String(o.side).toLowerCase() && isNum(ev.line) && Math.abs(ev.line - o.line) < EPS
      && (!ev.book || !o.sportsbook || String(ev.book).toLowerCase() === String(o.sportsbook).toLowerCase())
      && (!isNum(ev.price) || !isNum(o.american_exact) || Math.abs(ev.price - o.american_exact) < 0.5);
    if (same && d.status) return { status: d.status, reason: d.reason || null, source: 'decision engine', evaluated: true };
    return { status: 'NOT_EVALUATED', evaluated: false, source: 'quote-level EV only',
      reason: d.status === 'NO_DECISION' && d.requires ? 'Decision engine: NO DECISION — ' + d.requires + '. The quote-level EV above is arithmetic, not a decision.'
        : 'The decision engine evaluated ' + (ev && isNum(ev.line) ? (ev.team || ev.side) + ' ' + lineText(ev.line) + (ev.book ? ' at ' + ev.book : '') : 'a different quote') + '; this exact quote has not been decided on and does not inherit that verdict.' };
  }

  /* ============================================================ HISTORY
     Pregame EV is frozen when a decision is logged and graded later at the
     exact line and price — never recomputed with today's model. */
  var FREEZE_FIELDS = ['game_id', 'sport', 'team', 'side', 'market_type', 'line', 'american_odds', 'decimal_odds', 'sportsbook', 'captured_at', 'quote_age_minutes',
    'model_version', 'projection_timestamp', 'model_win_probability', 'model_cover_probability', 'model_push_probability', 'model_loss_probability',
    'break_even_probability', 'probability_edge', 'expected_value', 'expected_value_pct', 'model_fair_odds', 'is_main_line', 'ev_state', 'calibration_status'];
  function freeze(o, extra) {
    extra = extra || {};
    if (!o) return null;
    var s = { schema: 'edgedesk_quote_ev_snapshot_v1', engine: VERSION, frozen_at: iso(extra.now || Date.now()) };
    FREEZE_FIELDS.forEach(function (k) { s[k] = o[k] === undefined ? null : o[k]; });
    s.adjusted_expected_value = o.adjusted && o.adjusted.available ? o.adjusted.expected_value : null;
    s.adjusted_cover_probability = o.adjusted && o.adjusted.available ? o.adjusted.model_cover_probability : null;
    s.tail_status = o.tail ? o.tail.status : null;
    s.decision_status = extra.decision_status || o.decision_status || null;
    s.decision_reason = extra.decision_reason || o.decision_reason || null;
    s.origin = extra.origin || 'QUOTE';
    s.snapshot_id = 'qev_' + hash([s.game_id, s.side, s.market_type, s.line, s.american_odds, s.sportsbook, s.captured_at, s.model_version, s.projection_timestamp, s.frozen_at]);
    return deepFreeze(s);
  }
  /* realized return per $1 at the frozen price: a push returns the stake */
  function realizedReturn(result, decimal) {
    if (!isNum(decimal) || !(decimal > 1)) return null;
    if (result === 'win') return decimal - 1;
    if (result === 'loss') return -1;
    if (result === 'push' || result === 'void') return 0;
    return null;
  }
  /* the result of a spread wager at its exact line from the final margin (home − away) */
  function spreadResult(side, line, finalHomeMargin) {
    var m = num(finalHomeMargin), L = num(line);
    if (m == null || L == null || (side !== 'home' && side !== 'away')) return null;
    var x = (side === 'home' ? m : -m) + L;
    return x > EPS ? 'win' : (x < -EPS ? 'loss' : 'push');
  }
  var EV_BUCKETS = [
    { key: 'lt0', label: 'EV < 0', lo: -Infinity, hi: 0 },
    { key: '0_2', label: '0–2%', lo: 0, hi: 0.02 },
    { key: '2_5', label: '2–5%', lo: 0.02, hi: 0.05 },
    { key: '5_10', label: '5–10%', lo: 0.05, hi: 0.10 },
    { key: '10_15', label: '10–15%', lo: 0.10, hi: 0.15 },
    { key: '15p', label: '15%+', lo: 0.15, hi: Infinity }
  ];
  /* rows: {expected_value, model_cover_probability, result ('win'|'loss'|'push'),
     decimal_odds, clv_points} — one per frozen, graded wager */
  function evBuckets(rows, opts) {
    opts = opts || {};
    var minN = opts.min_n == null ? 30 : opts.min_n;
    var list = (rows || []).filter(function (x) { return x && isNum(num(x.expected_value)); });
    return EV_BUCKETS.map(function (b) {
      var inB = list.filter(function (x) { var e = num(x.expected_value); return e >= b.lo && e < b.hi; });
      var settled = inB.filter(function (x) { return x.result === 'win' || x.result === 'loss' || x.result === 'push'; });
      var decided = settled.filter(function (x) { return x.result !== 'push'; });
      var wins = decided.filter(function (x) { return x.result === 'win'; }).length;
      var rets = settled.map(function (x) { return realizedReturn(x.result, num(x.decimal_odds)); }).filter(isNum);
      var preds = decided.map(function (x) { return num(x.model_cover_probability); }).filter(isNum);
      var clv = inB.map(function (x) { return num(x.clv_points); }).filter(isNum);
      var mean = function (a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; };
      var winRate = decided.length ? wins / decided.length : null, avgPred = mean(preds);
      var roi = rets.length ? rets.reduce(function (s, v) { return s + v; }, 0) / rets.length : null;
      var enough = settled.length >= minN;
      return { bucket: b.label, key: b.key, n: inB.length, n_settled: settled.length, n_decided: decided.length,
        avg_stated_ev: r(mean(inB.map(function (x) { return num(x.expected_value); })), 4),
        win_rate: r(winRate, 4), avg_predicted_probability: r(avgPred, 4),
        calibration_error: isNum(winRate) && isNum(avgPred) ? r(winRate - avgPred, 4) : null,
        avg_clv_points: r(mean(clv), 3), positive_clv_rate: clv.length ? r(clv.filter(function (v) { return v > 0; }).length / clv.length, 3) : null,
        roi: r(roi, 4), avg_realized_return: r(roi, 4), total_units: rets.length ? r(rets.reduce(function (s, v) { return s + v; }, 0), 3) : null,
        sufficient_n: enough, note: enough ? null : 'n < ' + minN + ': shown for completeness, not evidence' };
    });
  }

  /* ============================================================ DISPLAY */
  function evText(o) {
    if (!o) return 'EV —';
    if (!o.ev_available) return 'EV —';
    return 'EV ' + signedPct(o.expected_value, 1);
  }
  function evTone(x) { return !isNum(x) ? 'mut' : (x >= 0.02 ? 'pos' : (x > -0.02 ? 'flat' : 'neg')); }

  return {
    VERSION: VERSION, TOOLTIP: TOOLTIP, UNAVAILABLE: UNAVAILABLE, EV_BUCKETS: EV_BUCKETS, SLOPE_BAND: SLOPE_BAND, LARGE_EV: LARGE_EV,
    /* odds */
    americanToDecimal: americanToDecimal, decimalToAmerican: decimalToAmerican, americanDisplay: americanDisplay, priceOf: priceOf,
    breakEven: breakEven, breakEvenUnconditional: breakEvenUnconditional, expectedValue: expectedValue,
    fairDecimal: fairDecimal, fairAmerican: fairAmerican, centsBetter: centsBetter,
    /* probability */
    sideProb: sideProb, totalProb: totalProb, cfbConditionedCover: cfbConditionedCover, tailDomain: tailDomain, MAIN_BAND_PTS: MAIN_BAND_PTS, mainBandPts: mainBandPts,
    /* quotes */
    priceQuote: priceQuote, evaluateGame: evaluateGame, otherMarkets: otherMarkets, ladder: ladder, mainLineOf: mainLineOf, keysBetween: keysBetween,
    sanity: sanity, decisionFor: decisionFor,
    /* history */
    freeze: freeze, realizedReturn: realizedReturn, spreadResult: spreadResult, evBuckets: evBuckets,
    /* display */
    evText: evText, evTone: evTone, lineText: lineText, priceText: priceText, pct: pct, signedPct: signedPct, ppText: ppText
  };
}));

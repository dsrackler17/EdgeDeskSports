/* ===========================================================================
   EDGEDESK MARKET — the ONE canonical description of a market.
   docs/bettor-decision/QUALITY_UPGRADE.md §2

   Before this file every surface decided for itself what "the current line"
   was: the research board read the consensus research card, the quote-EV
   board its own best price per number, the decision engine the modal home
   line of its normalised quotes, the share card and the exports whatever
   the decision happened to carry. They mostly agreed. This module makes them
   agree by construction: the decision engine builds ONE canonical market
   object per decision (EDMarket.canonical) and every downstream surface
   reads that object.

     canonical(opts)      event_id, sport, market_type, selection, line, odds,
                          sportsbook, captured_at, age_seconds, orientation,
                          verification_status, market_depth, book_count,
                          consensus_line, sharp_reference_line,
                          best_execution_price, source, quality, movement
     consensus(quotes)    per-book numbers (latest main quote per book) →
                          median, mean, freshness-and-sharp-weighted mean,
                          modal, consensus line, sharp reference, dispersion,
                          book agreement, outliers
     freshness(t, now)    FRESH / AGING / STALE / FUTURE / UNKNOWN — the one
                          quote-age rule (decision limit 90 min, as
                          lib/edgedesk_decision.js DEFAULT_CONFIG.freshness)
     quality(market)      a 0-100 market-quality INDEX from measured inputs
                          only. It is not a probability and is never printed
                          as one.
     movement(history)    opening, current, high, low, velocity, and what the
                          move did relative to EdgeDesk's number — described,
                          never attributed ("steam-like", never "sharp money")

   RULES
     - A consensus is a line books actually deal: the modal number when most
       books sit on it, otherwise the median snapped to the half point (the
       same rule as lib/market_consensus.js, pinned by a parity test). The
       weighted mean is reported beside it, never used as the line.
     - One sportsbook far from every other is an OUTLIER, named with the
       distance, and the decision engine will not promote it to BET until it
       verifies. Two books that disagree with nothing to break the tie are
       UNRESOLVED, not an outlier each.
     - Missing is missing: an unmeasured component is null and the quality
       index renormalises over what was measured and lists what was not.
       Nothing is filled with zero.

   Browser: window.EDMarket. Node: require('./edgedesk_market.js').
   ES5, no dependencies.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDMarket = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_market_v1';

  /* ------------------------------------------------------------- helpers */
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function upper(s) { return s == null ? null : String(s).toUpperCase(); }
  function half(x) { return isNum(x) ? Math.round(x * 2) / 2 : null; }
  function quantile(s, q) { if (!s.length) return null; var p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function a2d(a) { a = num(a); if (a == null || (a > -100 && a < 100)) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function ptsText(x) { return isNum(x) ? (Math.round(Math.abs(x) * 10) / 10).toString() + (Math.abs(Math.abs(x) - 1) < EPS ? ' point' : ' points') : '—'; }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ============================================================== CONFIG */
  var CONFIG = {
    version: 'edgedesk_market_config_v1',
    /* the decision quote-age limit is lib/edgedesk_decision.js
       freshness.max_quote_age_minutes (90); the research-card "stale market"
       limit (lib/edgedesk_canon.js THRESHOLDS.stale_minutes) is 180 and
       answers a different question (is there any market to research?) */
    freshness: { fresh_minutes: 30, max_minutes: 90, future_tolerance_minutes: 5, research_stale_minutes: 180 },
    /* books whose prices are widely used as a market reference. A sharp
       reference is REPORTED beside the consensus, never substituted for it */
    sharp_books: ['pinnacle', 'circa', 'circasports', 'bookmaker', 'bookmakereu', 'betcris'],
    weights: { sharp: 2, standard: 1, aging: 0.5 },
    /* per-league tolerances: how far a book may sit from the consensus
       before it is an outlier (spreads the decision engine's
       consensus_tolerance_pts; totals and moneyline no-vig probability) */
    leagues: {
      NFL: { spread_pts: 1.0, total_pts: 1.5, ml_pp: 3.0, move_pts: 0.5, steam_pts: 1.0, steam_minutes: 30 },
      CFB: { spread_pts: 1.5, total_pts: 2.0, ml_pp: 4.0, move_pts: 1.0, steam_pts: 1.5, steam_minutes: 30 }
    },
    dispersion: { spread: [0.5, 1.5], total: [0.5, 1.5], moneyline: [1.5, 3.0] },
    quality: {
      weights: { freshness: 0.20, depth: 0.15, agreement: 0.15, dispersion: 0.10, outlier: 0.15, orientation: 0.10, two_sided: 0.10, liquidity: 0.05 },
      labels: [[80, 'HIGH'], [60, 'ADEQUATE'], [40, 'LIMITED'], [0, 'POOR']]
    },
    movement_window_hours: 3
  };
  function leagueOf(s) { return upper(s) === 'NFL' ? 'NFL' : 'CFB'; }
  function tolOf(sport, mt) { var L = CONFIG.leagues[leagueOf(sport)]; return mt === 'total' ? L.total_pts : (mt === 'moneyline' ? L.ml_pp / 100 : L.spread_pts); }

  /* ============================================================ QUOTES
     Reads a raw quote (the decision engine's input), a priced quote
     (EDQuoteEV output) or a tracker record into one shape. */
  function bookKey(b) { return String(b == null ? '' : b).toLowerCase().replace(/^record:/, '').replace(/[^a-z0-9]+/g, ''); }
  function isSharp(b) { var k = bookKey(b); return CONFIG.sharp_books.indexOf(k) >= 0; }
  function marketOf(q) {
    var mt = q.market_type;
    if (mt === 'alternate_spread') return 'spread';
    if (mt) return mt;
    var s = String(q.side || '').toLowerCase();
    return s === 'over' || s === 'under' ? 'total' : 'spread';
  }
  function readQuote(q) {
    if (!q) return null;
    var mt = marketOf(q);
    var am = num(q.american != null ? q.american : (q.american_odds != null ? q.american_odds : (q.american_exact != null ? q.american_exact : q.odds)));
    var dec = num(q.decimal != null ? q.decimal : q.decimal_odds);
    if (dec == null) dec = a2d(am);
    var main = q.market_type === 'alternate_spread' ? false : (q.is_main_line === false ? false : true);
    return { side: q.side == null ? null : String(q.side).toLowerCase(), team: q.team || null, line: num(q.line), american: am, decimal: dec,
      book: q.book || q.sportsbook || null, book_key: bookKey(q.book || q.sportsbook), captured_at: iso(q.captured_at || q.observed_at),
      market_type: mt, is_main: main, fresh_flag: q.fresh === false ? false : (q.fresh === true ? true : null),
      freshness_state: upper(q.freshness_state || q.quote_status), n_books: Math.max(1, Math.round(num(q.n_books != null ? q.n_books : q.n_books_at_line) || 1)) };
  }
  /* the caller's own freshness verdict (a TTL ladder by hours to kickoff)
     outranks the age rule when it says STALE: this file never revives a
     quote its source has retired */
  function freshOf(q, now) {
    var f = freshness(q.captured_at, now);
    if ((q.fresh_flag === false || q.freshness_state === 'STALE') && f.state !== 'UNKNOWN') return { state: 'STALE', age_seconds: f.age_seconds, age_minutes: f.age_minutes, text: (f.text || '') + ' — retired by its source' };
    return f;
  }

  /* ========================================================= FRESHNESS */
  function freshness(t, now, over) {
    var F = over ? { fresh_minutes: num(over.fresh_minutes) != null ? num(over.fresh_minutes) : CONFIG.freshness.fresh_minutes, max_minutes: num(over.max_minutes) != null ? num(over.max_minutes) : CONFIG.freshness.max_minutes, future_tolerance_minutes: CONFIG.freshness.future_tolerance_minutes } : CONFIG.freshness;
    var at = ms(t), n = ms(now);
    if (at == null || n == null) return { state: 'UNKNOWN', age_seconds: null, age_minutes: null, text: 'capture time unknown' };
    var age = (n - at) / 1000, m = age / 60;
    if (m < -F.future_tolerance_minutes) return { state: 'FUTURE', age_seconds: Math.round(age), age_minutes: r(m, 1), text: 'the capture time is in the future (clock fault)' };
    var st = m <= F.fresh_minutes ? 'FRESH' : (m <= F.max_minutes ? 'AGING' : 'STALE');
    return { state: st, age_seconds: Math.max(0, Math.round(age)), age_minutes: r(Math.max(0, m), 1),
      text: (m < 60 ? Math.max(0, Math.round(m)) + ' min' : r(m / 60, 1) + ' h') + ' old' + (st === 'STALE' ? ' — past the ' + F.max_minutes + '-minute decision limit' : '') };
  }

  /* ========================================================= CONSENSUS
     One number per book: its latest main-market quote. Spreads are compared
     home-stated, totals on the total, moneylines as the no-vig home win
     probability of that book's two prices. */
  /* a capture that stores one row per NUMBER (the best price and how many
     books deal it) is expanded into that many books at that number, counting
     the side that shows more books (a book deals both sides of one number) —
     lib/market_consensus.js normalize()'s rule */
  function aggregatedRows(quotes, mt, now) {
    var H = quotes.filter(function (q) { return q.market_type === mt && q.is_main && (mt !== 'moneyline') && q.side === (mt === 'total' ? 'over' : 'home') && isNum(q.line); });
    var A = quotes.filter(function (q) { return q.market_type === mt && q.is_main && (mt !== 'moneyline') && q.side === (mt === 'total' ? 'under' : 'away') && isNum(q.line); });
    var sum = function (xs) { return xs.reduce(function (s, q) { return s + q.n_books; }, 0); };
    var use = sum(H) >= sum(A) ? H : A, mirror = use === A && mt === 'spread';
    var rows = [];
    use.forEach(function (q) {
      for (var i = 0; i < q.n_books; i++) rows.push({ book: i === 0 ? q.book : null, book_key: i === 0 ? q.book_key : q.book_key + '#' + i, sharp: i === 0 && isSharp(q.book_key),
        captured_at: q.captured_at, value: mirror ? -q.line : q.line, price_home: i === 0 && !mirror ? q.american : null, price_away: i === 0 && mirror ? q.american : null,
        two_sided: quotes.some(function (x) { return x.market_type === mt && x.is_main && x.side !== q.side && isNum(x.line) && (mt === 'total' ? Math.abs(x.line - q.line) < EPS : Math.abs(x.line + q.line) < EPS); }),
        freshness: freshOf(q, now), aggregated: true });
    });
    return rows;
  }
  function perBook(quotes, mt, now) {
    if (mt !== 'moneyline' && quotes.some(function (q) { return q.market_type === mt && q.is_main && q.n_books > 1; })) return aggregatedRows(quotes, mt, now);
    var by = {};
    quotes.forEach(function (q) {
      if (!q || q.market_type !== mt || !q.book_key) return;
      if (mt === 'spread' && !q.is_main) return;
      (by[q.book_key] = by[q.book_key] || []).push(q);
    });
    var rows = [];
    Object.keys(by).forEach(function (k) {
      var qs = by[k], tMax = null;
      qs.forEach(function (q) { var t = ms(q.captured_at); if (t != null && (tMax == null || t > tMax)) tMax = t; });
      var latest = tMax == null ? qs : qs.filter(function (q) { return ms(q.captured_at) === tMax; });
      var row = { book: latest[0].book, book_key: k, sharp: isSharp(k), captured_at: tMax == null ? null : iso(tMax), value: null, price_home: null, price_away: null,
        two_sided: false, freshness: latest.every(function (q) { return q.fresh_flag === false || q.freshness_state === 'STALE'; }) ? freshOf(latest[0], now) : freshness(tMax, now) };
      if (mt === 'spread') {
        var h = latest.filter(function (q) { return q.side === 'home' && isNum(q.line); })[0], a = latest.filter(function (q) { return q.side === 'away' && isNum(q.line); })[0];
        row.value = h ? h.line : (a ? -a.line : null);
        row.price_home = h ? h.american : null; row.price_away = a ? a.american : null;
        row.two_sided = !!(h && a && Math.abs(h.line + a.line) < EPS);
      } else if (mt === 'total') {
        var o = latest.filter(function (q) { return q.side === 'over' && isNum(q.line); })[0], u = latest.filter(function (q) { return q.side === 'under' && isNum(q.line); })[0];
        row.value = o ? o.line : (u ? u.line : null);
        row.price_home = o ? o.american : null; row.price_away = u ? u.american : null;
        row.two_sided = !!(o && u && Math.abs(o.line - u.line) < EPS);
      } else if (mt === 'moneyline') {
        var hm = latest.filter(function (q) { return q.side === 'home'; })[0], am = latest.filter(function (q) { return q.side === 'away'; })[0];
        row.price_home = hm ? hm.american : null; row.price_away = am ? am.american : null;
        var dh = hm ? hm.decimal : null, da = am ? am.decimal : null;
        if (isNum(dh) && isNum(da) && dh > 1 && da > 1) { var ih = 1 / dh, ia = 1 / da; row.value = ih / (ih + ia); row.two_sided = true; }
      }
      if (isNum(row.value)) rows.push(row);
    });
    rows.sort(function (x, y) { return x.book_key < y.book_key ? -1 : (x.book_key > y.book_key ? 1 : 0); });
    return rows;
  }
  /* the line books deal: modal when a majority sits on it, else the median
     snapped to the half point (lib/market_consensus.js's rule). Moneyline
     probabilities are not on a grid: their consensus is the median. */
  function centre(vals, mt) {
    var s = vals.slice().sort(function (a, b) { return a - b; });
    var med = quantile(s, 0.5);
    if (mt === 'moneyline') return { consensus: med, median: med, modal: null, modal_n: 0, basis: 'median of ' + s.length + ' books’ no-vig probabilities' };
    var counts = {}, modal = null, modalN = 0;
    s.forEach(function (v) { var k = String(r(v, 2)); counts[k] = (counts[k] || 0) + 1; });
    Object.keys(counts).forEach(function (k) { var v = Number(k); if (counts[k] > modalN || (counts[k] === modalN && Math.abs(v - med) < Math.abs(modal - med))) { modal = v; modalN = counts[k]; } });
    var majority = modalN / s.length > 0.5;
    return { consensus: majority ? modal : half(med), median: med, modal: modal, modal_n: modalN,
      basis: majority ? modalN + ' of ' + s.length + ' books on ' + (mt === 'total' ? String(modal) : lineText(modal)) + ' (modal)' : 'median of ' + s.length + ' books, to the half point' };
  }
  function consensus(quotes, opts) {
    opts = opts || {};
    var mt = opts.market_type || 'spread', sport = leagueOf(opts.sport), now = opts.now != null ? opts.now : null, tol = tolOf(sport, mt);
    var qs = (quotes || []).map(readQuote).filter(Boolean);
    var all = perBook(qs, mt, now);
    var usable = all.filter(function (b) { return b.freshness.state !== 'STALE' && b.freshness.state !== 'FUTURE'; });
    var basisRows = usable.length ? usable : all;
    var out = { schema: VERSION, market_type: mt, sport: sport, tolerance: mt === 'moneyline' ? r(tol * 100, 1) + ' pp' : tol + ' pts',
      books: all.filter(function (b) { return b.book; }).map(function (b) { return { book: b.book, sharp: b.sharp, value: r(b.value, 4), price_home: b.price_home, price_away: b.price_away, two_sided: b.two_sided, captured_at: b.captured_at, freshness: b.freshness.state }; }),
      basis_rows: all.some(function (b) { return b.aggregated; }) ? 'captured numbers (books per number; only the best book at each number is named)' : 'per-book quotes (latest main quote per book)',
      book_count: all.length, fresh_book_count: usable.length, consensus: null, median: null, mean: null, weighted_mean: null, modal: null, basis: null,
      sharp_reference: null, dispersion: { range: null, iqr: null, sd: null, level: null, measured_on: null }, agreement: null, agreement_label: null,
      outliers: [], unresolved: null, stale_only: !usable.length && all.length > 0, is_consensus: basisRows.length >= 2 };
    if (!basisRows.length) return out;
    var vals = basisRows.map(function (b) { return b.value; });
    var c = centre(vals, mt);
    out.consensus = r(c.consensus, 4); out.median = r(c.median, 4); out.modal = c.modal; out.basis = c.basis + (usable.length ? '' : ' (every quote is stale)');
    out.mean = r(mean(vals), 4);
    /* outliers first, so the weighted mean is taken without them */
    var outKeys = {}, nOut = 0;
    if (basisRows.length >= 3) basisRows.forEach(function (b) { var off = b.value - c.median; if (Math.abs(off) >= tol - EPS && Math.abs(off) > EPS) { outKeys[b.book_key] = true; nOut++; } });
    /* an outlier is a MINORITY against books that agree: when the books off
       the median are not outnumbered by at least two that sit on it, the
       market is split, not one book wrong */
    var nIn = basisRows.length - nOut;
    var split = nOut > 0 && (nIn < 2 || nIn <= nOut);
    if (split) { outKeys = {}; nOut = 0; }
    var wSum = 0, wv = 0;
    basisRows.forEach(function (b) { if (outKeys[b.book_key]) return; var w = (b.sharp ? CONFIG.weights.sharp : CONFIG.weights.standard) * (b.freshness.state === 'AGING' ? CONFIG.weights.aging : 1); wSum += w; wv += w * b.value; });
    out.weighted_mean = wSum > 0 ? r(wv / wSum, 4) : null;
    out.weighting = 'sharp books ×' + CONFIG.weights.sharp + ', aging quotes ×' + CONFIG.weights.aging + ', outliers excluded; reported beside the consensus, never used as the line';
    var sharp = basisRows.filter(function (b) { return b.sharp; });
    if (sharp.length) {
      var sv = sharp.map(function (b) { return b.value; }).sort(function (a, b) { return a - b; });
      out.sharp_reference = { value: r(quantile(sv, 0.5), 4), books: sharp.map(function (b) { return b.book; }), captured_at: sharp.map(function (b) { return b.captured_at; }).sort().pop() || null };
    }
    var s = vals.slice().sort(function (a, b) { return a - b; });
    var range = s[s.length - 1] - s[0], iqr = quantile(s, 0.75) - quantile(s, 0.25), m0 = mean(s);
    var sd = s.length > 1 ? Math.sqrt(s.reduce(function (a, v) { return a + (v - m0) * (v - m0); }, 0) / (s.length - 1)) : null;
    var D = CONFIG.dispersion[mt] || CONFIG.dispersion.spread, scale = mt === 'moneyline' ? 100 : 1;
    var measure = s.length >= 4 ? iqr : range;
    out.dispersion = { range: r(range * scale, 3), iqr: r(iqr * scale, 3), sd: r(isNum(sd) ? sd * scale : null, 3), unit: mt === 'moneyline' ? 'pp' : 'pts',
      measured_on: s.length >= 4 ? 'interquartile range' : (s.length >= 2 ? 'full range' : null),
      level: s.length < 2 ? null : (measure * scale <= D[0] + EPS ? 'LOW' : (measure * scale <= D[1] + EPS ? 'MODERATE' : 'HIGH')) };
    if (s.length >= 2) {
      var within = basisRows.filter(function (b) { return Math.abs(b.value - c.consensus) <= tol + EPS; }).length;
      out.agreement = r(within / basisRows.length, 3);
      out.agreement_label = s.length >= 3 && out.agreement >= 0.8 ? 'STRONG' : (out.agreement >= 0.6 ? 'MODERATE' : 'WEAK');
    }
    /* outliers: three or more books let the median decide; with two, only a
       sharp reference can say which one is off the market */
    if (basisRows.length >= 3) {
      basisRows.forEach(function (b) { var off = b.value - c.median; if (outKeys[b.book_key] && !out.outliers.some(function (x) { return x.book === b.book && Math.abs(x.value - b.value) < EPS; })) out.outliers.push({ book: b.book, value: r(b.value, 4), off_by: r(off * scale, 2), unit: mt === 'moneyline' ? 'pp' : 'pts' }); });
    }
    if (split) {
      var sv0 = basisRows.map(function (b) { return b.value; }), apart0 = Math.max.apply(null, sv0) - Math.min.apply(null, sv0);
      out.unresolved = { books: basisRows.filter(function (b) { return b.book; }).map(function (b) { return b.book; }), apart: r(apart0 * scale, 2), text: 'the books are split ' + r(apart0 * scale, 1) + (mt === 'moneyline' ? ' pp' : ' pts') + ' apart with no majority on one number' };
    } else if (basisRows.length === 2 && Math.abs(basisRows[0].value - basisRows[1].value) >= 2 * tol - EPS) {
      var sh = basisRows.filter(function (b) { return b.sharp; });
      if (sh.length === 1) { var other = basisRows.filter(function (b) { return !b.sharp; })[0]; out.outliers.push({ book: other.book, value: r(other.value, 4), off_by: r((other.value - sh[0].value) * scale, 2), unit: mt === 'moneyline' ? 'pp' : 'pts', against: 'sharp reference' }); }
      else out.unresolved = { books: basisRows.map(function (b) { return b.book; }), apart: r(Math.abs(basisRows[0].value - basisRows[1].value) * scale, 2), text: 'two books disagree by ' + r(Math.abs(basisRows[0].value - basisRows[1].value) * scale, 1) + (mt === 'moneyline' ? ' pp' : ' pts') + ' and nothing breaks the tie' };
    }
    return out;
  }
  /* the outlier row for a book — or, on a capture that names only the best
     book at each number, for the NUMBER the selected quote sits on */
  function outlierOf(cons, book, value) {
    var k = bookKey(book), L = (cons && cons.outliers) || [];
    var byBook = k ? L.filter(function (o) { return o.book && bookKey(o.book) === k; })[0] : null;
    if (byBook) return byBook;
    if (isNum(value)) return L.filter(function (o) { return !o.book && Math.abs(o.value - value) < EPS; })[0] || null;
    return null;
  }
  /* the sentence the decision engine prints for an off-market quote:
     "Caesars: Chicago +3.5. Consensus: Chicago +1. The quote is 2.5 points
      away from consensus. EdgeDesk will not promote this to BET until verified." */
  function outlierText(cons, q, team) {
    var rq = readQuote(q);
    var hv = rq && isNum(rq.line) ? (cons && cons.market_type === 'spread' && rq.side === 'away' ? -rq.line : rq.line) : null;
    var o = outlierOf(cons, q && (q.book || q.sportsbook), rq && rq.is_main ? hv : null);
    if (!o || !cons || !isNum(cons.consensus)) return null;
    var side = q.side, mt = cons.market_type;
    var sideVal = function (hv) { return mt === 'spread' ? (side === 'away' ? -hv : hv) : hv; };
    var lbl = function (v) { return mt === 'total' ? String(side || '').charAt(0).toUpperCase() + String(side || '').slice(1) + ' ' + v : (mt === 'moneyline' ? (team || side) + ' ' + r(100 * v, 1) + '% (no-vig)' : (team || side) + ' ' + lineText(v)); };
    return 'PRICE ANOMALY — ' + (q.book || q.sportsbook || 'a book') + ': ' + lbl(sideVal(o.value)) + '. Consensus: ' + lbl(sideVal(cons.consensus)) + '. The quote is '
      + (mt === 'moneyline' ? Math.abs(o.off_by).toFixed(1) + ' pp' : ptsText(o.value - cons.consensus)) + ' away from consensus. EdgeDesk will not promote this to BET until verified.';
  }

  /* ========================================================= QUALITY
     A market-quality INDEX, 0-100, from measured inputs only. Not a
     probability: it says how much the price can be trusted as a price. */
  function quality(parts) {
    parts = parts || {};
    var C = {}, notes = [], unmeasured = [];
    var f = parts.freshness ? parts.freshness.state : null;
    C.freshness = f === 'FRESH' ? 1 : (f === 'AGING' ? r(1 - 0.5 * Math.min(1, Math.max(0, ((parts.freshness.age_minutes || 0) - CONFIG.freshness.fresh_minutes) / (CONFIG.freshness.max_minutes - CONFIG.freshness.fresh_minutes))), 3) : (f === 'STALE' || f === 'FUTURE' ? 0 : null));
    var n = num(parts.book_count);
    C.depth = n == null || n < 1 ? null : [0, 0.25, 0.5, 0.7, 0.85, 1][Math.min(5, n)];
    C.agreement = isNum(parts.agreement) ? parts.agreement : null;
    C.dispersion = parts.dispersion_level ? { LOW: 1, MODERATE: 0.6, HIGH: 0.2 }[parts.dispersion_level] : null;
    C.outlier = parts.selected_outlier === true ? 0 : (parts.other_outliers ? 0.8 : (n != null && n >= 3 ? 1 : null));
    var o = upper(parts.orientation);
    C.orientation = o === 'OK' ? 1 : (o === 'REPAIRED' ? 0.7 : (o === 'AMBIGUOUS' ? 0.3 : null));
    C.two_sided = parts.two_sided === true ? 1 : (parts.two_sided === false ? 0.4 : null);
    C.liquidity = parts.sharp_present === true ? 1 : (parts.sharp_present === false && n != null && n >= 1 ? 0.6 : null);
    var W = CONFIG.quality.weights, wSum = 0, tot = 0;
    Object.keys(W).forEach(function (k) { if (isNum(C[k])) { wSum += W[k]; tot += W[k] * C[k]; } else unmeasured.push(k); });
    if (C.depth === 0.25) notes.push('one book');
    if (parts.selected_outlier) notes.push('the selected quote is an outlier');
    if (!wSum) return { score: null, label: 'UNMEASURED', components: C, unmeasured: unmeasured, notes: ['nothing about this market was measurable'], note: 'A market-quality index (0–100), not a probability.' };
    var score = Math.round(100 * tot / wSum), label = 'POOR', caps = [];
    /* GATES, not averages: a broken property caps the index whatever the rest says */
    function capAt(v, why) { if (score > v) { score = v; caps.push(why); } }
    if (parts.selected_outlier === true) capAt(45, 'the selected quote is off the market');
    if (f === 'STALE' || f === 'FUTURE') capAt(30, 'the selected quote is stale');
    if (o === 'AMBIGUOUS') capAt(40, 'the orientation is ambiguous');
    if (n === 1) capAt(64, 'a single book cannot be corroborated');
    for (var i = 0; i < CONFIG.quality.labels.length; i++) if (score >= CONFIG.quality.labels[i][0]) { label = CONFIG.quality.labels[i][1]; break; }
    return { score: score, label: label, components: C, weights: copy(W), unmeasured: unmeasured, measured_weight: r(wSum, 3), notes: notes, caps: caps,
      note: 'A market-quality index (0–100) from quote age, depth, book agreement, dispersion, outliers, orientation, two-sidedness and a sharp-book liquidity proxy. It is not a probability.' };
  }

  /* ========================================================= MOVEMENT
     history: [{at, value}] on the market's own scale (home-stated spread,
     total, or no-vig home probability). opts.fair: EdgeDesk's number on the
     same scale. Describes what happened, never who caused it. */
  function movement(history, opts) {
    opts = opts || {};
    var L = CONFIG.leagues[leagueOf(opts.sport)], mt = opts.market_type || 'spread';
    var thr = mt === 'moneyline' ? L.ml_pp / 100 : L.move_pts, steamPts = mt === 'moneyline' ? L.ml_pp / 100 : L.steam_pts;
    var h = (history || []).map(function (x) { return { at: ms(x.at || x.captured_at || x.observed_at), value: num(x.value != null ? x.value : (x.home_line != null ? x.home_line : x.line)), book: x.book || null }; })
      .filter(function (x) { return x.at != null && isNum(x.value); }).sort(function (a, b) { return a.at - b.at; });
    if (!h.length) return { available: false, reason: 'no line history on file', indicators: [] };
    var vals = h.map(function (x) { return x.value; });
    var open = h[0], cur = h[h.length - 1], now = ms(opts.now) || cur.at;
    var out = { available: true, market_type: mt, opening: { value: open.value, at: iso(open.at) }, current: { value: cur.value, at: iso(cur.at) },
      high: Math.max.apply(null, vals), low: Math.min.apply(null, vals), change: r(cur.value - open.value, 3), n_points: h.length, velocity_per_hour: null, indicators: [], key_numbers_crossed: [] };
    var winStart = now - CONFIG.movement_window_hours * 3600e3, base = null;
    h.forEach(function (x) { if (x.at <= winStart) base = x; });
    if (!base) base = h[0];
    var hrs = (cur.at - base.at) / 3600e3;
    out.velocity_per_hour = hrs > 0.05 ? r((cur.value - base.value) / hrs, 3) : null;
    out.velocity_window = 'last ' + CONFIG.movement_window_hours + ' h';
    function ind(code, text) { out.indicators.push({ code: code, text: text }); }
    var unit = mt === 'moneyline' ? function (x) { return r(Math.abs(100 * x), 1) + ' pp'; } : function (x) { return ptsText(x); };
    var fair = num(opts.fair);
    if (isNum(fair)) {
      var d = Math.abs(open.value - fair) - Math.abs(cur.value - fair);
      if (d >= thr - EPS) ind('LINE_MOVED_TOWARD_MODEL', 'Since the open the line moved ' + unit(cur.value - open.value) + ' toward EdgeDesk’s number.');
      else if (d <= -thr + EPS) ind('LINE_MOVED_AGAINST_MODEL', 'Since the open the line moved ' + unit(cur.value - open.value) + ' away from EdgeDesk’s number.');
      var ev = ms(opts.evaluated_at);
      if (ev != null) {
        var atEval = null;
        h.forEach(function (x) { if (x.at <= ev) atEval = x; });
        if (atEval && cur.at > atEval.at) {
          var d2 = Math.abs(atEval.value - fair) - Math.abs(cur.value - fair);
          if (d2 >= thr - EPS) ind('MARKET_CONFIRMING', 'After EdgeDesk’s evaluation the market moved ' + unit(cur.value - atEval.value) + ' toward EdgeDesk’s number.');
          else if (d2 <= -thr + EPS) ind('MARKET_REJECTING', 'After EdgeDesk’s evaluation the market moved ' + unit(cur.value - atEval.value) + ' away from EdgeDesk’s number.');
        }
      }
    }
    /* a fast move: the largest change inside any steam window */
    var best = null;
    for (var i = 0; i < h.length; i++) for (var j = i + 1; j < h.length && h[j].at - h[i].at <= L.steam_minutes * 60e3; j++) {
      var mv = Math.abs(h[j].value - h[i].value);
      if (!best || mv > best.mv) best = { mv: mv, minutes: Math.round((h[j].at - h[i].at) / 60e3) };
    }
    if (best && best.mv >= steamPts - EPS) ind('STEAM_LIKE_MOVE', 'A fast move: ' + unit(best.mv) + ' in ' + best.minutes + ' minutes. EdgeDesk describes the move; it does not know who caused it.');
    /* key numbers crossed on the way (spreads/totals; the keys come from the
       caller — EDExecution derives them from the league's own distribution) */
    if (mt !== 'moneyline' && opts.keys && opts.keys.length && Math.abs(cur.value - open.value) > EPS) {
      var lo = Math.min(open.value, cur.value), hi = Math.max(open.value, cur.value), touched = [];
      opts.keys.forEach(function (k) { (mt === 'total' ? [k] : [k, -k]).forEach(function (s) { if (s > lo - EPS && s < hi + EPS) touched.push(s); }); });
      out.key_numbers_crossed = touched.filter(function (s) { return Math.abs(s - open.value) > EPS && Math.abs(s - cur.value) > EPS; });
      out.key_numbers_left = touched.filter(function (s) { return Math.abs(s - open.value) < EPS; });
      out.key_numbers_landed = touched.filter(function (s) { return Math.abs(s - cur.value) < EPS; });
      var kt = function (k) { return mt === 'total' ? String(Math.abs(k)) : lineText(k); };
      if (out.key_numbers_crossed.length) ind('CROSSED_KEY_NUMBER', 'The line moved through ' + out.key_numbers_crossed.map(kt).join(', ') + '.');
      else if (out.key_numbers_left.length || out.key_numbers_landed.length) ind('KEY_NUMBER_TOUCHED', 'The line ' + (out.key_numbers_left.length ? 'moved off ' + out.key_numbers_left.map(kt).join(', ') : '') + (out.key_numbers_left.length && out.key_numbers_landed.length ? ' and ' : '') + (out.key_numbers_landed.length ? 'landed on ' + out.key_numbers_landed.map(kt).join(', ') : '') + '.');
    }
    return out;
  }

  /* ========================================================= CANONICAL
     opts: { event_id, sport, market_type, quotes, selected, now, team,
             orientation: {status, repairs, dropped}, source, history, fair,
             evaluated_at, best_execution }
     `selected` is the quote the decision reads (bet_price or reference). */
  function canonical(opts) {
    opts = opts || {};
    var mt = opts.market_type || 'spread', sport = leagueOf(opts.sport), now = opts.now;
    var cons = consensus(opts.quotes || [], { market_type: mt, sport: sport, now: now });
    var sel = readQuote(opts.selected);
    var side = sel ? sel.side : null;
    var toSide = function (v) { return !isNum(v) ? null : (mt === 'spread' && side === 'away' ? -v : (mt === 'moneyline' && side === 'away' ? 1 - v : v)); };
    var fr = sel ? freshOf(sel, now) : { state: 'UNKNOWN', age_seconds: null, age_minutes: null };
    var selHome0 = sel && isNum(sel.line) ? (mt === 'spread' ? (sel.side === 'away' ? -sel.line : sel.line) : sel.line) : null;
    var outl = sel ? outlierOf(cons, sel.book, sel.is_main ? selHome0 : null) : null;
    var selRow = sel ? cons.books.filter(function (b) { return bookKey(b.book) === sel.book_key; })[0] : null;
    var twoSided = selRow ? !!selRow.two_sided : null;
    if (sel && sel.market_type === 'spread' && !sel.is_main) twoSided = (opts.quotes || []).map(readQuote).some(function (x) { return x && x.market_type === 'spread' && x.book_key === sel.book_key && x.side !== sel.side && isNum(x.line) && Math.abs(x.line + sel.line) < EPS; });
    var orient = opts.orientation || null, ost = orient ? upper(orient.status) : null;
    var tol = tolOf(sport, mt);
    var selHome = sel && isNum(sel.line) ? (mt === 'spread' ? (side === 'away' ? -sel.line : sel.line) : sel.line) : null;
    /* the selected BOOK's main number against the consensus (an alternate
       is judged by its book's main market) */
    var bookDev = selRow && isNum(cons.consensus) ? Math.abs(selRow.value - cons.consensus) : null;
    var vs, vt;
    if (!sel) { vs = 'NO_QUOTE'; vt = 'no quote selected'; }
    else if (fr.state === 'STALE' || fr.state === 'FUTURE') { vs = 'STALE'; vt = 'the quote is ' + fr.text; }
    else if (fr.state === 'UNKNOWN') { vs = 'UNVERIFIED'; vt = 'the quote carries no capture time'; }
    else if (outl) { vs = 'OUTLIER'; vt = outlierText(cons, opts.selected, opts.team); }
    else if (cons.unresolved) { vs = 'UNRESOLVED'; vt = cons.unresolved.text; }
    else if (cons.fresh_book_count <= 1) { vs = 'SINGLE_SOURCE'; vt = 'only one fresh book prices this market: nothing to corroborate it'; }
    else if (bookDev != null && bookDev <= tol + EPS && twoSided !== false && ost !== 'AMBIGUOUS') { vs = 'VERIFIED'; vt = cons.fresh_book_count + ' fresh books; this book’s number sits within ' + (mt === 'moneyline' ? r(tol * 100, 1) + ' pp' : tol + ' pts') + ' of the consensus and both sides are priced'; }
    else { vs = 'CORROBORATED'; vt = cons.fresh_book_count + ' fresh books price this market' + (twoSided === false ? '; this exact number is priced on one side only' : ''); }
    var Q = quality({ freshness: fr, book_count: cons.fresh_book_count || cons.book_count, agreement: cons.agreement, dispersion_level: cons.dispersion.level,
      selected_outlier: !!outl, other_outliers: cons.outliers.length > (outl ? 1 : 0), orientation: ost || (sel ? 'OK' : null), two_sided: twoSided,
      sharp_present: cons.book_count ? !!cons.sharp_reference : null });
    var mv = opts.history ? movement(opts.history, { sport: sport, market_type: mt, fair: opts.fair, evaluated_at: opts.evaluated_at, now: now, keys: opts.keys }) : null;
    return {
      schema: 'edgedesk_canonical_market_v1', version: VERSION, config_version: CONFIG.version,
      event_id: opts.event_id != null ? String(opts.event_id) : null, sport: sport, market_type: mt,
      selection: sel ? { side: side, team: opts.team || sel.team || null, is_main_line: sel.is_main } : null,
      line: sel ? sel.line : null, home_line: selHome, odds: sel ? sel.american : null, decimal: sel ? r(sel.decimal, 4) : null,
      sportsbook: sel ? sel.book : null, captured_at: sel ? sel.captured_at : null, age_seconds: fr.age_seconds, freshness: fr.state, freshness_text: fr.text || null,
      orientation: { status: ost || (sel ? 'OK' : null), certain: ost == null || ost === 'OK', repairs: orient && orient.repairs ? orient.repairs.length : 0, dropped: orient && orient.dropped ? orient.dropped.length : 0 },
      verification_status: vs, verification_text: vt,
      market_depth: { books: cons.book_count, fresh_books: cons.fresh_book_count, two_sided: twoSided, sharp_present: !!cons.sharp_reference },
      book_count: cons.book_count,
      consensus_line: toSide(cons.consensus), consensus_home_line: mt === 'spread' ? cons.consensus : null, consensus_value: cons.consensus,
      consensus_basis: cons.basis, weighted_mean: toSide(cons.weighted_mean), median: toSide(cons.median), mean: toSide(cons.mean),
      sharp_reference_line: cons.sharp_reference ? toSide(cons.sharp_reference.value) : null, sharp_reference_books: cons.sharp_reference ? cons.sharp_reference.books : [],
      dispersion: cons.dispersion, agreement: cons.agreement, agreement_label: cons.agreement_label,
      outliers: cons.outliers, unresolved: cons.unresolved, selected_is_outlier: !!outl, selected_book_deviation: bookDev == null ? null : r(mt === 'moneyline' ? 100 * bookDev : bookDev, 2),
      anomaly: outl ? { code: 'QUOTE_OUTLIER', text: vt } : null,
      best_execution_price: opts.best_execution || null,
      quality: Q, movement: mv, source: opts.source || null, as_of: iso(now),
      books: cons.books
    };
  }

  return {
    VERSION: VERSION, CONFIG: CONFIG,
    canonical: canonical, consensus: consensus, freshness: freshness, quality: quality, movement: movement,
    readQuote: readQuote, bookKey: bookKey, isSharp: isSharp, outlierOf: outlierOf, outlierText: outlierText, centre: centre, tolerance: tolOf
  };
}));

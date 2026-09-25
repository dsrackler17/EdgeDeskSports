/* ===========================================================================
   EdgeDesk MARKET CONSENSUS — many books in, one honest description out.

   A spread from one book is a quote. It is not a consensus, and nothing here
   will call it one. Given every book's quote for a game this computes:

     consensus_spread   the modal home line when a majority of books sit on
                        it, otherwise the median snapped to the half point.
                        Spreads live on a half-point grid with key numbers;
                        an arithmetic mean of -3, -3, -3.5, -3, -2.5 is
                        -3.0 by luck and -3.1 the next time, and -3.1 is a
                        line no book offers
     median_spread, modal_spread
     best_available     the best home line and the best away line, and where
     market_dispersion  range, IQR and a band: LOW (<= 0.5, a hook), MODERATE
                        (<= 1.5), HIGH
     books_reporting, outlier_books (1.5+ points from the median)
     market_freshness   the newest and oldest capture and their ages
     market_quality_score / grade  books, freshness, agreement,
                        completeness (spread price, moneyline, total) and
                        outliers, 0-100 -> STRONG / ADEQUATE / THIN / POOR

   COMPARISON EVIDENCE ONLY. The market is what EdgeDesk compares its number
   against; it is not an input to the projection, and this module is read by
   reliability, the research card and the diagnostics — never by the engine.

   Accepts per-book quotes, or the capture's aggregated rows (one row per
   point with the number of books quoting it), and says which it was given.

   Browser: window.EDMarketConsensus.  Node: require('./market_consensus.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDMarketConsensus = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var M = { version: 'market_consensus/1' };

  M.CONFIG = {
    outlier_pts: 1.5,
    dispersion: [{ key: 'LOW', max: 0.5 }, { key: 'MODERATE', max: 1.5 }, { key: 'HIGH', max: 1e9 }],
    /* quality points, this module's own weights: depth of the market first,
       then whether it is current, then whether the books agree */
    points: { books: 35, freshness: 25, agreement: 20, completeness: 15, no_outliers: 5 },
    full_books: 6,
    fresh_minutes: [15, 60, 180, 720],
    grades: [{ key: 'STRONG', min: 75 }, { key: 'ADEQUATE', min: 50 }, { key: 'THIN', min: 15 }, { key: 'POOR', min: 0 }]
  };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function ms(t) { if (t == null || t === '') return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  function half(x) { return x == null ? null : Math.round(x * 2) / 2; }
  function quantile(s, q) { if (!s.length) return null; var p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); }
  function fmt(x) { return x == null ? '—' : (x > 0 ? '+' : '') + (Math.round(x * 10) / 10); }

  /* normalize(o) -> per-book rows {book, spread (home line), spread_price,
     total, total_price, ml_home, ml_away, timestamp}
     o.books:   [{book|provider, spread|home_line, spread_price, total|over_under,
                  ml_home|home_moneyline, ml_away|away_moneyline, timestamp|updated_at}]
     o.points:  [{side:'home'|'away', line, n_books, best_book, price_dec, captured_at}]
                the capture's rows: the side's own line and how many books
                quote it. Expanded into n_books anonymous books at that point */
  function normalize(o) {
    var rows = [], basis = null;
    if (o && o.books && o.books.length) {
      basis = 'per-book quotes';
      o.books.forEach(function (b) {
        if (!b) return;
        var sp = num(b.spread != null ? b.spread : b.home_line);
        rows.push({ book: String(b.book || b.provider || 'book'), spread: sp,
          spread_price: num(b.spread_price), total: num(b.total != null ? b.total : b.over_under), total_price: num(b.total_price),
          ml_home: num(b.ml_home != null ? b.ml_home : b.home_moneyline), ml_away: num(b.ml_away != null ? b.ml_away : b.away_moneyline),
          timestamp: b.timestamp || b.updated_at || b.captured_at || null, aggregated: false });
      });
    } else if (o && o.points && o.points.length) {
      basis = 'captured points (books per point, identities of all but the best book not captured)';
      var home = o.points.filter(function (p) { return p && p.side === 'home' && num(p.line) != null; });
      var away = o.points.filter(function (p) { return p && p.side === 'away' && num(p.line) != null; });
      var sum = function (xs) { var s = 0; xs.forEach(function (p) { s += num(p.n_books) || 1; }); return s; };
      /* a book quotes both sides of one line: count the side that shows more
         books, never both */
      var use = sum(home) >= sum(away) ? home : away, mirror = use === away;
      use.forEach(function (p) {
        var n = Math.max(1, Math.round(num(p.n_books) || 1));
        for (var i = 0; i < n; i++) rows.push({ book: i === 0 && p.best_book ? String(p.best_book) : null,
          spread: mirror ? -p.line : p.line, spread_price: i === 0 ? num(p.price_dec) : null, total: null, total_price: null,
          ml_home: null, ml_away: null, timestamp: p.captured_at || null, aggregated: true });
      });
    }
    return { rows: rows, basis: basis };
  }

  /* consensus(o, now) */
  M.consensus = function (o, now, over) {
    var cfg = M.CONFIG, k;
    if (over) { cfg = {}; for (k in M.CONFIG) cfg[k] = M.CONFIG[k]; for (k in over) cfg[k] = over[k]; }
    var n0 = normalize(o || {});
    var rows = n0.rows.filter(function (r) { return r.spread != null; });
    var nowMs = ms(now);
    var out = { version: M.version, basis: n0.basis, books_reporting: rows.length,
      consensus_spread: null, median_spread: null, modal_spread: null, mean_spread_not_used: null,
      best_available: { home: null, away: null }, market_dispersion: { range: null, iqr: null, level: null },
      outlier_books: [], market_freshness: { newest: null, oldest: null, age_minutes: null, stale: null },
      total: { median: null, books: 0 }, moneyline: { books: 0 },
      completeness: { spread_price: false, moneyline: false, total: false },
      market_quality_score: 0, market_quality_grade: 'POOR', quality: {}, summary: null, is_consensus: false };
    if (!rows.length) { out.summary = 'NO MARKET — no book quotes a spread for this game'; out.quality = { why: 'no spread quote' }; return out; }
    var s = rows.map(function (r) { return r.spread; }).sort(function (a, b) { return a - b; });
    var med = quantile(s, 0.5);
    var counts = {}; s.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
    var modal = null, modalN = 0;
    Object.keys(counts).forEach(function (v) { if (counts[v] > modalN || (counts[v] === modalN && Math.abs(+v - med) < Math.abs(modal - med))) { modal = +v; modalN = counts[v]; } });
    out.median_spread = r2(med); out.modal_spread = modal;
    out.mean_spread_not_used = r2(s.reduce(function (a, v) { return a + v; }, 0) / s.length);
    out.consensus_spread = (modalN / s.length > 0.5) ? modal : half(med);
    out.consensus_basis = (modalN / s.length > 0.5) ? modalN + ' of ' + s.length + ' books on ' + fmt(modal) + ' (modal)' : 'median of ' + s.length + ' books, to the half point';
    out.is_consensus = rows.length >= 2;
    var range = s[s.length - 1] - s[0], iqr = quantile(s, 0.75) - quantile(s, 0.25);
    /* the band is read off the interquartile range once four or more books
       report, so one off-market book cannot set it (it is flagged as an
       outlier instead); with two or three books the full range is all there is */
    var spread = rows.length >= 4 ? iqr : range, lvl = null;
    if (rows.length >= 2) for (var i = 0; i < cfg.dispersion.length; i++) if (spread <= cfg.dispersion[i].max) { lvl = cfg.dispersion[i].key; break; }
    out.market_dispersion = { range: r2(range), iqr: r2(iqr), low: s[0], high: s[s.length - 1], level: lvl,
      measured_on: rows.length >= 4 ? 'interquartile range' : (rows.length >= 2 ? 'full range' : null),
      note: rows.length < 2 ? 'one quote has no dispersion to measure' : null };
    /* best for each side: the home bettor wants the largest home line, the
       away bettor the smallest (the away line is its negative) */
    var bh = null, ba = null;
    rows.forEach(function (r) {
      if (!bh || r.spread > bh.spread || (r.spread === bh.spread && (r.spread_price || 0) > (bh.spread_price || 0))) bh = r;
      if (!ba || r.spread < ba.spread) ba = r;
    });
    out.best_available = { home: { line: bh.spread, book: bh.book, price: bh.spread_price },
      away: { line: ba.spread == null ? null : -ba.spread, book: ba.book, price: ba.spread_price } };
    if (rows.length >= 3) rows.forEach(function (r) {
      if (Math.abs(r.spread - med) >= cfg.outlier_pts) out.outlier_books.push({ book: r.book, spread: r.spread, off_by: r2(r.spread - med) });
    });
    /* freshness */
    var ts = rows.map(function (r) { return ms(r.timestamp); }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    if (ts.length) {
      var newest = ts[ts.length - 1];
      out.market_freshness = { newest: new Date(newest).toISOString(), oldest: new Date(ts[0]).toISOString(),
        age_minutes: nowMs != null ? Math.max(0, Math.round((nowMs - newest) / 60e3)) : null,
        stale: nowMs != null ? (nowMs - newest) / 60e3 > cfg.fresh_minutes[cfg.fresh_minutes.length - 1] : null };
    } else out.market_freshness = { newest: null, oldest: null, age_minutes: null, stale: null, note: 'no capture time on any quote' };
    /* totals and moneylines, where books supplied them */
    var tot = rows.map(function (r) { return r.total; }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    out.total = { median: tot.length ? r2(quantile(tot, 0.5)) : null, books: tot.length };
    out.moneyline = { books: rows.filter(function (r) { return r.ml_home != null && r.ml_away != null; }).length };
    out.completeness = { spread_price: rows.some(function (r) { return r.spread_price != null; }), moneyline: out.moneyline.books > 0, total: tot.length > 0 };
    /* quality */
    var P = cfg.points, q = {};
    q.books = r2(P.books * Math.min(1, rows.length / cfg.full_books));
    var age = out.market_freshness.age_minutes, fm = cfg.fresh_minutes;
    q.freshness = age == null ? 0 : r2(P.freshness * (age <= fm[0] ? 1 : (age <= fm[1] ? 0.75 : (age <= fm[2] ? 0.5 : (age <= fm[3] ? 0.25 : 0)))));
    q.agreement = rows.length < 2 ? 0 : (lvl === 'LOW' ? P.agreement : (lvl === 'MODERATE' ? P.agreement / 2 : 0));
    q.completeness = r2(P.completeness * ((out.completeness.spread_price ? 1 : 0) + (out.completeness.moneyline ? 1 : 0) + (out.completeness.total ? 1 : 0)) / 3);
    q.no_outliers = rows.length >= 3 && !out.outlier_books.length ? P.no_outliers : 0;
    var score = Math.round(q.books + q.freshness + q.agreement + q.completeness + q.no_outliers);
    out.market_quality_score = score;
    for (var g = 0; g < cfg.grades.length; g++) if (score >= cfg.grades[g].min) { out.market_quality_grade = cfg.grades[g].key; break; }
    out.quality = q;
    out.summary = 'MARKET QUALITY — ' + out.market_quality_grade + ': ' + rows.length + ' book' + (rows.length === 1 ? '' : 's')
      + (rows.length >= 2 ? ', consensus ' + fmt(out.consensus_spread) + ' (range ' + fmt(s[0]) + ' to ' + fmt(s[s.length - 1]) + ')' : ', ' + fmt(s[0]) + ' — one quote, not a consensus')
      + (age != null ? ', last capture ' + (age < 60 ? age + 'm' : Math.round(age / 6) / 10 + 'h') + ' ago' : ', capture time unknown');
    return out;
  };

  /* the reliability scorer's market input, from a consensus */
  M.forReliability = function (c) {
    if (!c) return null;
    return { n_books: c.books_reporting || 0, dispersion: c.market_dispersion ? c.market_dispersion.level : null,
      quality_score: c.market_quality_score, quality_grade: c.market_quality_grade, is_consensus: !!c.is_consensus,
      outliers: (c.outlier_books || []).length };
  };

  return M;
});

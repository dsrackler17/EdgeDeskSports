/* ============================================================================
   EdgeDesk CFB Live Model Lab — the rules, in one place (browser + node, ES5).

   Every definition in docs/cfb-lab/METRICS.md is implemented here and only
   here: checkpoint windows, the OFFICIAL snapshot, quote de-duplication,
   openers and closes, ATS grading, units, CLV, error and probability scores,
   calibration buckets, interval coverage, data quality, near misses, miss
   classification, drift alerts and the promotion rule. The hourly job, the
   tests and the Model Lab page all load this file, so a number means the
   same thing everywhere.

   Pure functions only: no I/O, no clock unless one is passed, no hashing
   (ledger.js hashes in node; `render` below is the shared rendering those
   hashes use, identical to the Postgres cfb_lab_h()).

   SIGNS: home margin > 0 = home wins by that many; a home line of -7 = home
   lays 7; margin = -home_line, converted once (conv.bookToMargin).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDCfbLab = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var RULES = {
    ledger: 'cfb_lab_ledger_v1', checkpoint: 'cfb_lab_checkpoint_v1', official: 'cfb_lab_official_v1',
    open: 'cfb_lab_open_v1', close: 'cfb_lab_close_v1', dedupe: 'cfb_lab_quote_dedupe_v1',
    eval: 'cfb_lab_eval_v1', dq: 'cfb_lab_dq_v1', miss: 'cfb_lab_miss_v1', promotion: 'cfb_lab_promotion_v1',
    v1_decision: 'lab_rule:v1_gap_v1'
  };

  /* ------------------------------------------------------------ helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 3 : k); return Math.round(x * m) / m; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function sign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }

  /* Rendering shared with the Postgres id function (SCHEMA.md rule 4). */
  function render(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  function idParts(parts) { return parts.map(render).join('|'); }

  /* ----------------------------------------------------------- statistics */
  function vals(xs) { return (xs || []).filter(isNum); }
  function mean(xs) { xs = vals(xs); if (!xs.length) return null; var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; }
  function sd(xs) {
    xs = vals(xs); if (xs.length < 2) return null;
    var m = mean(xs), s = 0; for (var i = 0; i < xs.length; i++) s += (xs[i] - m) * (xs[i] - m);
    return Math.sqrt(s / (xs.length - 1));
  }
  function quantile(xs, q) {
    xs = vals(xs).slice().sort(function (a, b) { return a - b; }); if (!xs.length) return null;
    var pos = (xs.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  }
  function median(xs) {
    xs = vals(xs).slice().sort(function (a, b) { return a - b; }); if (!xs.length) return null;
    var m = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
  }
  function iqr(xs) {
    xs = vals(xs); if (!xs.length) return null;
    return quantile(xs, 0.75) - quantile(xs, 0.25);
  }
  /* seeded PRNG (mulberry32) so bootstrap intervals are reproducible */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0; var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function bootMeanCI(xs, B, seed) {
    xs = vals(xs); if (xs.length < 10) return [null, null];
    var R = rng(seed == null ? 20260927 : seed), out = [], n = xs.length, b, i, s;
    for (b = 0; b < (B || 2000); b++) { s = 0; for (i = 0; i < n; i++) s += xs[Math.floor(R() * n)]; out.push(s / n); }
    return [quantile(out, 0.025), quantile(out, 0.975)];
  }
  /* inverse standard normal CDF (Acklam) */
  function normInv(p) {
    if (!(p > 0 && p < 1)) return null;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    var q, rr, pl = 0.02425;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; rr = q * q;
    return (((((a[0] * rr + a[1]) * rr + a[2]) * rr + a[3]) * rr + a[4]) * rr + a[5]) * q / (((((b[0] * rr + b[1]) * rr + b[2]) * rr + b[3]) * rr + b[4]) * rr + 1);
  }
  function lgamma(x) {
    var c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, t = x + 5.5, s = 1.000000000190015, j;
    t -= (x + 0.5) * Math.log(t); for (j = 0; j < 6; j++) s += c[j] / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
  }
  /* E|T| for a unit-variance Student t with df > 2 (METRICS §13) */
  function tExpectedAbs(df) {
    if (!isNum(df) || df <= 2) return Math.sqrt(2 / Math.PI);
    var eAbsStd = 2 * Math.sqrt(df) * Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2)) / (Math.sqrt(Math.PI) * (df - 1));
    return eAbsStd * Math.sqrt((df - 2) / df);
  }
  function binomBand(p, n) {
    if (!n) return [null, null];
    var h = 1.96 * Math.sqrt(p * (1 - p) / n);
    return [p - h, p + h];
  }
  function sampleLabel(n) { return n < 30 ? 'small sample' : (n < 100 ? 'provisional' : null); }

  /* ------------------------------------------------------------- signs */
  var conv = {
    bookToMargin: function (homeLine) { return isNum(homeLine) ? (homeLine === 0 ? 0 : -homeLine) : null; },
    marginToBook: function (margin) { return isNum(margin) ? (margin === 0 ? 0 : -margin) : null; },
    sideLine: function (side, homeLine) { if (!isNum(homeLine)) return null; return side === 'AWAY' ? (homeLine === 0 ? 0 : -homeLine) : homeLine; },
    homeLineFromSide: function (side, sideLine) { if (!isNum(sideLine)) return null; return side === 'AWAY' ? (sideLine === 0 ? 0 : -sideLine) : sideLine; },
    display: function (margin, home, away) {
      if (!isNum(margin)) return null;
      var half = Math.round(Math.abs(margin) * 2) / 2;
      if (half === 0) return 'PICK';
      return (margin > 0 ? home : away) + ' -' + half.toFixed(1);
    }
  };

  /* -------------------------------------------------- checkpoints (§2-3) */
  var CHECKPOINTS = [
    { type: 'T72', lo: 48, hi: 72 }, { type: 'T48', lo: 24, hi: 48 }, { type: 'T24', lo: 12, hi: 24 },
    { type: 'T12', lo: 6, hi: 12 }, { type: 'T6', lo: 2, hi: 6 }, { type: 'T2', lo: 1, hi: 2 },
    { type: 'FINAL', lo: 0, hi: 1 }
  ];
  var CHECKPOINT_ORDER = ['OPEN', 'WEEKLY_FREEZE', 'T72', 'T48', 'T24', 'T12', 'T6', 'T2', 'FINAL', 'ADHOC'];
  function windowFor(hours) {
    if (!isNum(hours) || hours <= 0) return null;
    for (var i = 0; i < CHECKPOINTS.length; i++) if (hours > CHECKPOINTS[i].lo && hours <= CHECKPOINTS[i].hi) return CHECKPOINTS[i].type;
    return hours > 72 ? 'OPEN' : null;
  }
  /* which checkpoint (if any) a run at `hours` should record, given the
     checkpoint types this model already has for the game */
  function dueCheckpoint(hours, existingTypes) {
    var have = {}; (existingTypes || []).forEach(function (t) { have[t] = true; });
    var w = windowFor(hours);
    if (!w) return null;
    if (w === 'OPEN') {
      /* OPEN only for a model's first snapshot: any existing row means it is not first */
      return (existingTypes || []).length ? null : 'OPEN';
    }
    return have[w] ? null : w;
  }
  function familiesFor(checkpointType, isFirst, origin) {
    var f = [];
    if (isFirst) f.push('EARLY_MODEL');
    if (checkpointType === 'T48') f.push('MIDWEEK_MODEL');
    if (checkpointType === 'T24' && origin === 'LIVE') f.push('OFFICIAL');
    if (checkpointType === 'FINAL') f.push('FINAL_MODEL');
    return f;
  }
  function isOfficial(p) { return !!p && p.origin === 'LIVE' && p.checkpoint_type === 'T24'; }
  function hoursToKickoff(kickoff, at) {
    var k = ms(kickoff), t = ms(at);
    return (k === null || t === null) ? null : (k - t) / 3600000;
  }

  /* ------------------------------------------------- quotes (§4 dedupe) */
  var HEARTBEAT_H = 6, CLOSE_ZONE_H = 3, CLOSE_ZONE_HEARTBEAT_MIN = 50, CLOSE_WINDOW_MIN = 180, CLOSE_GRACE_H = 3, OPEN_BAND_H = 24;
  function quoteKey(q) { return [q.source, q.book, q.game_id || q.provider_event_id, q.market_type].join('|'); }
  function quoteValues(q) { return [num(q.home_line), num(q.total_points), num(q.price_home), num(q.price_away), num(q.price_over), num(q.price_under)]; }
  var QUOTE_SOURCES = ['espn', 'cfbd', 'odds_api', 'record'];
  var MARKET_TYPES = ['spread', 'total', 'moneyline'];
  /* why a quote can never be a stored quote (null = it can): METRICS §4 */
  function quoteRefusal(q) {
    if (QUOTE_SOURCES.indexOf(q.source) < 0) return 'unknown source';
    if (MARKET_TYPES.indexOf(q.market_type) < 0) return 'unknown market_type';
    if (!q.book) return 'no book';
    if ((q.game_id === null || q.game_id === undefined || q.game_id === '') && (q.provider_event_id === null || q.provider_event_id === undefined || q.provider_event_id === '')) return 'no game_id or provider_event_id';
    if (ms(q.observed_at) === null) return 'no observed_at';
    if (q.market_type === 'spread' && !isNum(num(q.home_line))) return 'spread without home_line';
    if (q.market_type === 'total' && !isNum(num(q.total_points))) return 'total without total_points';
    if (q.market_type === 'moneyline' && !isNum(nz(q.price_home)) && !isNum(nz(q.price_away))) return 'moneyline without a price';
    if (!!q.is_pregame === !!q.is_provider_close) return 'is_pregame must be the opposite of is_provider_close';
    if (q.is_provider_open && q.is_provider_close) return 'both provider flags';
    var k = ms(q.kickoff_ts);
    if (!q.is_provider_close && k !== null && ms(q.observed_at) >= k) return 'observed at or after kickoff';
    return null;
  }
  function nz(x) { x = num(x); return x === 0 ? null : x; }
  /* decision for one new ORDINARY observation (not provider-declared) against
     the latest ordinary stored row of its key: 'written' | 'duplicate' |
     'refused' (METRICS §4). Provider-declared rows are kept once per key and
     flag (market.selectNew). */
  function dedupeDecision(latest, obs) {
    if (quoteRefusal(obs)) return 'refused';
    var t = ms(obs.observed_at), k = ms(obs.kickoff_ts);
    if (!latest) return 'written';
    var same = idParts(quoteValues(latest)) === idParts(quoteValues(obs));
    if (!same) return 'written';
    var ageH = (t - ms(latest.observed_at)) / 3600000;
    if (ageH >= HEARTBEAT_H) return 'written';
    if (k !== null && (k - t) / 3600000 <= CLOSE_ZONE_H && ageH * 60 >= CLOSE_ZONE_HEARTBEAT_MIN) return 'written';
    return 'duplicate';
  }

  function isRealBook(b) { return b && String(b).toLowerCase() !== 'consensus'; }
  function pickBooks(entries) {
    /* when any real sportsbook is present, provider averages are left out */
    var real = entries.filter(function (e) { return isRealBook(e.book); });
    return real.length ? real : entries;
  }
  function hasValue(q, market) {
    if (market === 'moneyline') return isNum(num(q.price_home)) || isNum(num(q.price_away));
    return isNum(lineValue(q, market));
  }
  function lineValue(q, market) { return market === 'total' ? num(q.total_points) : (market === 'spread' ? num(q.home_line) : null); }
  /* Values of a line row: spread -> home_line + prices, total -> total_points
     + over/under prices (in price_home/price_away), moneyline -> prices; a
     consensus spread also carries the best number per side (METRICS §4). */
  function consensusOf(entries, market, extra) {
    var xs = entries.map(function (e) { return lineValue(e, market); }).filter(isNum);
    var out = {
      home_line: market === 'spread' ? r2(median(xs)) : null,
      total_points: market === 'total' ? r2(median(xs)) : null,
      price_home: medPrice(entries, market === 'total' ? 'price_over' : 'price_home'),
      price_away: medPrice(entries, market === 'total' ? 'price_under' : 'price_away'),
      n_books: entries.length,
      best_line_home: null, best_line_away: null
    };
    if (market === 'spread' && xs.length) {
      out.best_line_home = r2(Math.max.apply(null, xs));
      out.best_line_away = r2(conv.bookToMargin(Math.min.apply(null, xs)));
    }
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) out[k] = extra[k];
    return out;
  }
  function r2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }
  /* American <-> decimal; a price median is taken in decimal-odds space
     (American odds straddle +/-100) and rounded half away from zero. */
  function toDecimal(a) { a = num(a); if (!isNum(a) || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / (-a); }
  function fromDecimal(d) { if (!isNum(d) || d <= 1) return null; return d >= 2 ? (d - 1) * 100 : -100 / (d - 1); }
  function roundHalfAway(x) { return x < 0 ? -Math.round(-x) : Math.round(x); }
  function medianPrice(prices) {
    var ds = (prices || []).map(toDecimal).filter(isNum);
    if (!ds.length) return null;
    var a = fromDecimal(median(ds));
    return isNum(a) ? roundHalfAway(a) : null;
  }
  function medPrice(entries, col) { return medianPrice(entries.map(function (e) { return e[col]; })); }
  /* per (source, book): each feed's report of a book is its own series */
  function byBook(quotes) {
    var g = {};
    quotes.forEach(function (q) { var k = q.source + ':' + q.book; (g[k] = g[k] || []).push(q); });
    return g;
  }
  function byIdAsc(a, b) { return String(a.quote_id) < String(b.quote_id) ? -1 : (String(a.quote_id) > String(b.quote_id) ? 1 : 0); }
  function sortByTime(qs) { return qs.slice().sort(function (a, b) { return (ms(a.observed_at) - ms(b.observed_at)) || byIdAsc(a, b); }); }
  /* per book: earliest (ties: quote_id ascending) / latest (ties: quote_id ascending) */
  function earliestPerBook(qs) {
    var b = byBook(qs), out = [];
    Object.keys(b).sort().forEach(function (k) { out.push(sortByTime(b[k])[0]); });
    return out;
  }
  function latestPerBook(qs) {
    var b = byBook(qs), out = [];
    Object.keys(b).sort().forEach(function (k) {
      var s = b[k].slice().sort(function (x, y) { return (ms(y.observed_at) - ms(x.observed_at)) || byIdAsc(x, y); });
      out.push(s[0]);
    });
    return out;
  }
  function ordinary(q, market, kickoff) {
    var t = ms(q.observed_at), k = ms(kickoff);
    return q.market_type === market && q.is_pregame !== false && !q.is_provider_open && !q.is_provider_close
      && hasValue(q, market) && t !== null && (k === null || t < k);
  }
  function missingLine() {
    return { home_line: null, total_points: null, price_home: null, price_away: null, n_books: 0, observed_at: null, quality: 'MISSING',
      best_line_home: null, best_line_away: null, quote_ids: [] };
  }
  function tsOf(qs, fn) { return iso(fn.apply(null, qs.map(function (q) { return ms(q.observed_at); }))); }

  /* Opening line (§4, cfb_lab_open_v1) over the quotes of one game and market,
     optionally only those observed by `asOf` (the snapshot's view). Per book:
     its earliest ordinary pregame quote. Consensus: the books whose opener is
     within 24 h of the earliest opener, the provider average left out when a
     real book is among them, median; observed_at = the earliest opener used.
     Fallback: the provider-declared openers (per book its latest; observed_at
     null), then MISSING. */
  function openerFrom(quotes, market, asOf, kickoff) {
    var cut = ms(asOf);
    var seen = (quotes || []).filter(function (q) { return cut === null || ms(q.observed_at) <= cut; });
    var per = earliestPerBook(seen.filter(function (q) { return ordinary(q, market, kickoff); }));
    if (per.length) {
      var t0 = Math.min.apply(null, per.map(function (q) { return ms(q.observed_at); }));
      var inBand = pickBooks(per.filter(function (q) { return ms(q.observed_at) <= t0 + OPEN_BAND_H * 3600000; }));
      return { per_book: per, consensus: consensusOf(inBand, market, { observed_at: tsOf(inBand, Math.min), quality: 'OBSERVED', quote_ids: ids(inBand) }) };
    }
    var decl = seen.filter(function (q) { return q.market_type === market && q.is_provider_open && hasValue(q, market); });
    if (decl.length) {
      decl = pickBooks(latestPerBook(decl));
      return { per_book: [], consensus: consensusOf(decl, market, { observed_at: null, quality: 'PROVIDER_DECLARED', quote_ids: ids(decl) }) };
    }
    return { per_book: [], consensus: missingLine() };
  }
  function ids(qs) { return qs.map(function (q) { return q.quote_id; }).sort(); }
  /* Closing line (§4, cfb_lab_close_v1): per book the latest ordinary pregame
     quote in [kickoff - 180 min, kickoff); consensus = median over the books
     (provider average left out when a real book closed), observed_at = the
     latest close used, best number per side. Fallback: the provider-declared
     closes (per book its latest; observed_at null), then MISSING. */
  function closeFrom(quotes, market, kickoff) {
    var k = ms(kickoff);
    var qs = (quotes || []).filter(function (q) { return ordinary(q, market, kickoff) && k !== null && ms(q.observed_at) >= k - CLOSE_WINDOW_MIN * 60000; });
    var per = latestPerBook(qs);
    if (per.length) {
      var used = pickBooks(per);
      return { per_book: per, consensus: consensusOf(used, market, { observed_at: tsOf(used, Math.max), quality: 'OBSERVED', quote_ids: ids(used) }) };
    }
    var decl = (quotes || []).filter(function (q) { return q.market_type === market && q.is_provider_close && hasValue(q, market); });
    if (decl.length) {
      decl = pickBooks(latestPerBook(decl));
      return { per_book: [], consensus: consensusOf(decl, market, { observed_at: null, quality: 'PROVIDER_DECLARED', quote_ids: ids(decl) }) };
    }
    return { per_book: [], consensus: missingLine() };
  }
  function closeDue(kickoff, now) { var k = ms(kickoff), t = ms(now); return k !== null && t !== null && t >= k + CLOSE_GRACE_H * 3600000; }

  /* The market as a snapshot at `asOf` sees it: each book's latest pregame
     spread quote observed by then (and within 36 h), median, IQR, best number
     per side with its price, opener as known, staleness. */
  var CURRENT_MAX_AGE_H = 36;
  function marketAt(quotes, asOf, kickoff) {
    var t = ms(asOf);
    var sp = (quotes || []).filter(function (q) {
      var o = ms(q.observed_at);
      return q.market_type === 'spread' && q.is_pregame !== false && !q.is_provider_open && !q.is_provider_close
        && isNum(num(q.home_line)) && o !== null && o <= t && (t - o) <= CURRENT_MAX_AGE_H * 3600000;
    });
    var per = latestPerBook(sp);
    var used = pickBooks(per);
    var open = openerFrom(quotes, 'spread', asOf, kickoff).consensus;
    var tot = latestPerBook((quotes || []).filter(function (q) {
      var o = ms(q.observed_at); return q.market_type === 'total' && q.is_pregame !== false && !q.is_provider_open && !q.is_provider_close && o !== null && o <= t && (t - o) <= CURRENT_MAX_AGE_H * 3600000;
    }));
    if (!used.length) {
      return { current_spread: null, sportsbook_count: 0, opening_spread: open.home_line, opening_market_ts: open.observed_at,
        opening_quality: open.quality, market_as_of: null, market_sources: [], market_stale: true, market_total: median(tot.map(function (q) { return num(q.total_points); })) };
    }
    var lines = used.map(function (q) { return num(q.home_line); });
    var cur = median(lines);
    var newest = Math.max.apply(null, used.map(function (q) { return ms(q.observed_at); }));
    var h = hoursToKickoff(kickoff, asOf);
    var staleH = (isNum(h) && h <= 48) ? 6 : 36;
    var bestHome = null, bestAway = null;
    used.forEach(function (q) {
      var hl = num(q.home_line);
      if (!bestHome || hl > bestHome.home_line || (hl === bestHome.home_line && betterPrice(q.price_home, bestHome.price_home))) bestHome = q;
      if (!bestAway || hl < bestAway.home_line || (hl === bestAway.home_line && betterPrice(q.price_away, bestAway.price_away))) bestAway = q;
    });
    var srcs = {}; used.forEach(function (q) { srcs[q.source] = true; });
    return {
      current_spread: cur, consensus_spread: cur, sportsbook_count: used.length, market_dispersion: r(iqr(lines), 3),
      best_available_spread_home: num(bestHome.home_line), best_price_home: num(bestHome.price_home),
      best_available_spread_away: conv.bookToMargin(num(bestAway.home_line)), best_price_away: num(bestAway.price_away),
      consensus_price_home: medPrice(used, 'price_home'), consensus_price_away: medPrice(used, 'price_away'),
      opening_spread: open.home_line, opening_market_ts: open.observed_at, opening_quality: open.quality,
      line_move_from_open: isNum(open.home_line) ? r(conv.bookToMargin(cur) - conv.bookToMargin(open.home_line), 2) : null,
      market_total: median(tot.map(function (q) { return num(q.total_points); })),
      market_as_of: iso(newest), market_sources: Object.keys(srcs).sort(),
      market_stale: (t - newest) / 3600000 > staleH,
      quote_ids: used.map(function (q) { return q.quote_id; }),
      books: used.map(function (q) { return { book: q.book, home_line: num(q.home_line), price_home: num(q.price_home), price_away: num(q.price_away) }; })
    };
  }
  function betterPrice(a, b) { a = num(a); b = num(b); if (!isNum(a)) return false; if (!isNum(b)) return true; return payout(a) > payout(b); }

  /* ------------------------------------------------ prices and grading */
  function payout(american) { american = num(american); if (!isNum(american) || american === 0) return null; return american > 0 ? american / 100 : 100 / (-american); }
  function impliedProb(american) { var p = payout(american); return p === null ? null : 1 / (1 + p); }
  /* ATS result for a side at a HOME line on the final home margin (§11) */
  function atsResult(side, homeLine, margin) {
    if (!side || !isNum(homeLine) || !isNum(margin)) return null;
    var x = margin + homeLine;
    var home = x > 0 ? 'WIN' : (x < 0 ? 'LOSS' : 'PUSH');
    if (side === 'HOME') return home;
    return home === 'WIN' ? 'LOSS' : (home === 'LOSS' ? 'WIN' : 'PUSH');
  }
  function unitsFor(result, stake, american) {
    if (!result || result === 'VOID' || !isNum(stake)) return null;
    if (result === 'PUSH') return 0;
    if (result === 'LOSS') return -stake;
    var p = payout(american); return p === null ? null : stake * p;
  }
  /* CLV in points (§9): (L_snapshot - L_close) x (+1 HOME, -1 AWAY), home lines */
  function clvPoints(side, snapHomeLine, closeHomeLine) {
    if (!side || !isNum(snapHomeLine) || !isNum(closeHomeLine)) return null;
    var d = snapHomeLine - closeHomeLine;
    return r(side === 'HOME' ? d : -d, 3);
  }
  function clvPrice(side, snapHomeLine, closeHomeLine, snapPrice, closePrice) {
    if (!side || !isNum(snapHomeLine) || !isNum(closeHomeLine) || snapHomeLine !== closeHomeLine) return null;
    var a = impliedProb(snapPrice), b = impliedProb(closePrice);
    return (a === null || b === null) ? null : r((b - a) * 100, 3);
  }

  /* ------------------------------------------------ decisions (§11-12) */
  var STATUS_TO_CLASS = { BET: 'BET', LEAN: 'LEAN', REVIEW: 'RESEARCH', PASS: 'PASS', NOT_PRICED: 'PASS' };
  function decisionClass(status) { return STATUS_TO_CLASS[status] || 'PASS'; }
  /* V1 publishes no decision: the football record's lean rule (|gap| >= 2) */
  var V1_LEAN_GAP = 2;
  function v1Decision(gap) {
    if (!isNum(gap)) return { status: 'PASS', side: null, reason: 'no market line to compare' };
    var side = gap > 0 ? 'HOME' : (gap < 0 ? 'AWAY' : null);
    if (Math.abs(gap) >= V1_LEAN_GAP) return { status: 'LEAN', side: side, reason: 'V1 differs from the market by ' + r(Math.abs(gap), 1) + ' pts (record lean rule: >= 2)' };
    return { status: 'PASS', side: side, reason: 'V1 within ' + V1_LEAN_GAP + ' pts of the market' };
  }
  function thresholdDistance(ev, gapAbs, rel, rule) {
    if (!rule) return null;
    return {
      ev_minus_lean_ev: isNum(ev) && isNum(rule.lean_ev) ? r(ev - rule.lean_ev, 4) : null,
      ev_minus_bet_ev: isNum(ev) && isNum(rule.bet_ev) ? r(ev - rule.bet_ev, 4) : null,
      gap_minus_bet_gap: isNum(gapAbs) && isNum(rule.bet_gap) ? r(gapAbs - rule.bet_gap, 3) : null,
      reliability_minus_bet_min: isNum(rel) && isNum(rule.bet_min_rel) ? r(rel - rule.bet_min_rel, 1) : null
    };
  }
  var NEAR = { ev: 0.01, gap: 0.5, rel: 5 };
  function nearMiss(decisionClassValue, td) {
    if (!td || (decisionClassValue !== 'PASS' && decisionClassValue !== 'LEAN')) return false;
    var fails = [], ok = true;
    var checks = [['ev_minus_bet_ev', NEAR.ev], ['gap_minus_bet_gap', NEAR.gap], ['reliability_minus_bet_min', NEAR.rel]];
    checks.forEach(function (c) { var v = td[c[0]]; if (isNum(v) && v < 0) fails.push([v, c[1]]); });
    if (!fails.length) return false;
    fails.forEach(function (f) { if (-f[0] > f[1]) ok = false; });
    return ok;
  }

  /* ------------------------------------------------ data quality (§14) */
  var DQ_RANK = { GREEN: 0, YELLOW: 1, RED: 2 };
  function dqStatus(checks) {
    var worst = 'GREEN';
    (checks || []).forEach(function (c) { if (DQ_RANK[c.status] > DQ_RANK[worst]) worst = c.status; });
    return worst;
  }
  function confidenceCap(status) { return status === 'RED' ? 40 : (status === 'YELLOW' ? 75 : 100); }
  function consensusScore(ensSd) { return isNum(ensSd) ? Math.round(100 * Math.max(0, 1 - ensSd / 6)) : null; }
  function expectedAbsError(sigma, df) { return isNum(sigma) ? r(sigma * tExpectedAbs(df), 3) : null; }
  function impliedSigma(margin, pHome) {
    if (!isNum(margin) || !isNum(pHome) || pHome <= 0.02 || pHome >= 0.98 || Math.abs(margin) < 1) return null;
    var z = normInv(pHome); if (!isNum(z) || Math.abs(z) < 1e-6) return null;
    var s = margin / z; return s > 0 ? r(s, 3) : null;
  }

  /* ------------------------------------------------ evaluation (§5-11) */
  /* pred: a prediction ledger row. result: the current result row for the
     game. lines: { open, close } consensus spread lines (derived rows) — may be
     null. Returns the evaluation fields (METRICS §6-11). */
  function evaluate(pred, result, lines) {
    lines = lines || {};
    var e = { prediction_id: pred.prediction_id, game_id: pred.game_id, model_version: pred.model_version,
      checkpoint_type: pred.checkpoint_type, origin: pred.origin, official: isOfficial(pred),
      eval_version: RULES.eval, result_id: result ? result.result_id : null,
      result_status: result ? result.status : null, void: false };
    if (!result) return e;
    if (result.status !== 'FINAL') {
      e.void = true; e.ats_result = 'VOID'; e.ats_result_at_close = 'VOID';
      e.decision_class = pred.decision_class; e.side = pred.side;
      return e;
    }
    var m = result.home_points - result.away_points, tot = result.home_points + result.away_points;
    var mu = num(pred.pure_home_margin);
    e.final_home_points = result.home_points; e.final_away_points = result.away_points;
    e.final_margin = m; e.final_total = tot; e.overtime = result.overtime == null ? null : !!result.overtime;
    e.margin_error = r(m - mu, 3); e.abs_margin_error = r(Math.abs(m - mu), 3); e.squared_margin_error = r((m - mu) * (m - mu), 3);
    e.home_points_error = isNum(num(pred.projected_home_points)) ? r(result.home_points - num(pred.projected_home_points), 2) : null;
    e.away_points_error = isNum(num(pred.projected_away_points)) ? r(result.away_points - num(pred.projected_away_points), 2) : null;
    e.total_error = isNum(num(pred.projected_total)) ? r(tot - num(pred.projected_total), 2) : null;
    e.winner_correct = mu === 0 ? null : (sign(mu) === sign(m));
    var p = num(pred.home_win_probability);
    e.p_home = p; e.home_won = m > 0 ? 1 : 0;
    if (isNum(p)) {
      var pc = clamp(p, 1e-6, 1 - 1e-6);
      e.brier_win = r((p - e.home_won) * (p - e.home_won), 5);
      e.log_loss_win = r(-(e.home_won * Math.log(pc) + (1 - e.home_won) * Math.log(1 - pc)), 5);
    } else { e.brier_win = null; e.log_loss_win = null; }
    [50, 80, 95].forEach(function (k) {
      var lo = num(pred['interval_' + k + '_low']), hi = num(pred['interval_' + k + '_high']);
      e['in_interval_' + k] = (isNum(lo) && isNum(hi)) ? (m >= lo && m <= hi) : null;
    });
    /* market accuracy + discovery (§9-10) */
    var openL = (lines.open && lines.open.quality !== 'MISSING' && isNum(num(lines.open.home_line))) ? num(lines.open.home_line) : num(pred.opening_spread);
    var openQ = (lines.open && lines.open.quality !== 'MISSING' && isNum(num(lines.open.home_line))) ? lines.open.quality : (isNum(num(pred.opening_spread)) ? (pred.opening_quality || 'OBSERVED') : 'MISSING');
    var closeL = (lines.close && lines.close.quality !== 'MISSING') ? num(lines.close.home_line) : null;
    e.open_home_line = openL; e.open_quality = openQ;
    e.close_home_line = closeL; e.close_quality = lines.close ? lines.close.quality : 'MISSING';
    e.close_line_id = lines.close ? lines.close.line_id || null : null; e.close_books = lines.close ? lines.close.n_books || 0 : 0;
    var absErr = Math.abs(m - mu);
    if (isNum(openL)) {
      e.open_abs_error = r(Math.abs(m - conv.bookToMargin(openL)), 3);
      e.edgedesk_beat_open = absErr < e.open_abs_error; e.tie_vs_open = absErr === e.open_abs_error;
      e.error_diff_vs_open = r(absErr - e.open_abs_error, 3);
      e.edge_vs_open = r(mu - conv.bookToMargin(openL), 3);
    } else { e.open_abs_error = null; e.edgedesk_beat_open = null; e.error_diff_vs_open = null; e.edge_vs_open = null; }
    if (isNum(closeL)) {
      e.close_abs_error = r(Math.abs(m - conv.bookToMargin(closeL)), 3);
      e.edgedesk_beat_close = absErr < e.close_abs_error; e.tie_vs_close = absErr === e.close_abs_error;
      e.error_diff_vs_close = r(absErr - e.close_abs_error, 3);
    } else { e.close_abs_error = null; e.edgedesk_beat_close = null; e.error_diff_vs_close = null; }
    if (isNum(openL) && isNum(closeL) && isNum(e.edge_vs_open) && e.edge_vs_open !== 0) {
      e.market_move_points = r((conv.bookToMargin(closeL) - conv.bookToMargin(openL)) * sign(e.edge_vs_open), 3);
      e.market_move_toward_model = e.market_move_points > 0;
    } else { e.market_move_points = null; e.market_move_toward_model = null; }
    var gap = num(pred.model_market_gap), snapL = num(pred.current_spread);
    e.move_since_snapshot = (isNum(closeL) && isNum(snapL) && isNum(gap) && gap !== 0)
      ? r((conv.bookToMargin(closeL) - conv.bookToMargin(snapL)) * sign(gap), 3) : null;
    /* decision grading (§11) */
    var side = pred.side || null;
    e.decision_class = pred.decision_class; e.side = side;
    var gradedHomeLine = side ? conv.homeLineFromSide(side, num(pred.recommended_line)) : null;
    if (side && !isNum(gradedHomeLine)) gradedHomeLine = snapL;
    e.graded_line = side && isNum(gradedHomeLine) ? conv.sideLine(side, gradedHomeLine) : null;
    var price = num(pred.recommended_price);
    e.price_assumed = side ? !isNum(price) : null;
    e.graded_price = side ? (isNum(price) ? price : -110) : null;
    e.ats_result = side ? atsResult(side, gradedHomeLine, m) : null;
    e.ats_result_at_close = side ? atsResult(side, closeL, m) : null;
    e.stake_units = num(pred.stake_units) || 0;
    e.units = (side && e.stake_units > 0) ? r(unitsFor(e.ats_result, e.stake_units, e.graded_price), 4) : 0;
    e.hypothetical_units = side ? r(unitsFor(e.ats_result, 1, e.graded_price), 4) : null;
    var cp = num(pred.cover_probability);
    e.cover_probability = cp;
    e.covered = (e.ats_result === 'WIN') ? true : (e.ats_result === 'LOSS' ? false : null);
    e.brier_cover = (isNum(cp) && e.covered !== null) ? r((cp - (e.covered ? 1 : 0)) * (cp - (e.covered ? 1 : 0)), 5) : null;
    e.clv_points = side ? clvPoints(side, gradedHomeLine, closeL) : null;
    var closePrice = lines.close ? (side === 'HOME' ? num(lines.close.price_home) : num(lines.close.price_away)) : null;
    e.clv_price = side ? clvPrice(side, gradedHomeLine, closeL, price, closePrice) : null;
    e.positive_clv = isNum(e.clv_points) ? (e.clv_points > 0 || (e.clv_points === 0 && isNum(e.clv_price) && e.clv_price > 0)) : null;
    /* process vs outcome (§11) */
    var pq = 'UNKNOWN';
    if (isNum(e.clv_points) && e.clv_points !== 0) pq = e.clv_points > 0 ? 'GOOD' : 'POOR';
    else if (!isNum(e.clv_points) && isNum(e.move_since_snapshot) && e.move_since_snapshot > 0) pq = 'GOOD';
    e.process_quality = side ? pq : null;
    var oc = e.ats_result;
    e.outcome_quadrant = (!side || pq === 'UNKNOWN' || !oc || oc === 'PUSH') ? 'UNKNOWN'
      : (pq === 'GOOD' ? (oc === 'WIN' ? 'GOOD_PROCESS_WIN' : 'GOOD_PROCESS_LOSS') : (oc === 'WIN' ? 'POOR_PROCESS_WIN' : 'POOR_PROCESS_LOSS'));
    return e;
  }

  /* ------------------------------------------------ aggregation (§6-8) */
  function errorSummary(evals) {
    var es = (evals || []).filter(function (e) { return !e.void && isNum(e.margin_error); });
    var err = es.map(function (e) { return e.margin_error; }), abs = es.map(function (e) { return e.abs_margin_error; });
    var n = es.length;
    var favB = es.map(function (e) { var mu = e.final_margin - e.margin_error; return mu === 0 ? null : e.margin_error * sign(mu); }).filter(isNum);
    return {
      n: n, label: sampleLabel(n),
      mae: r(mean(abs), 3), rmse: n ? r(Math.sqrt(mean(es.map(function (e) { return e.squared_margin_error; }))), 3) : null,
      median_ae: r(median(abs), 3), bias: r(mean(err), 3), p90_ae: r(quantile(abs, 0.9), 3), p95_ae: r(quantile(abs, 0.95), 3),
      mae_se: n > 1 ? r(sd(abs) / Math.sqrt(n), 3) : null,
      favorite_bias: r(mean(favB), 3), favorite_bias_se: favB.length > 1 ? r(sd(favB) / Math.sqrt(favB.length), 3) : null,
      total_mae: r(mean(es.map(function (e) { return isNum(e.total_error) ? Math.abs(e.total_error) : null; })), 3),
      winner_accuracy: r(mean(es.map(function (e) { return e.winner_correct === null || e.winner_correct === undefined ? null : (e.winner_correct ? 1 : 0); })), 4),
      brier: r(mean(es.map(function (e) { return e.brier_win; })), 5),
      log_loss: r(mean(es.map(function (e) { return e.log_loss_win; })), 5),
      coverage_50: r(mean(es.map(function (e) { return b01(e.in_interval_50); })), 4),
      coverage_80: r(mean(es.map(function (e) { return b01(e.in_interval_80); })), 4),
      coverage_95: r(mean(es.map(function (e) { return b01(e.in_interval_95); })), 4),
      n_intervals: es.filter(function (e) { return e.in_interval_80 === true || e.in_interval_80 === false; }).length
    };
  }
  function b01(x) { return x === true ? 1 : (x === false ? 0 : null); }

  var PROB_BUCKETS = [[0.50, 0.55, '50-55'], [0.55, 0.60, '55-60'], [0.60, 0.65, '60-65'], [0.65, 0.70, '65-70'], [0.70, 0.75, '70-75'], [0.75, 0.80, '75-80'], [0.80, 1.0001, '80+']];
  /* pairs: [{p, y}] with p the probability of the event whose outcome is y.
     fold: true folds to the favourite (p<.5 -> 1-p, y -> 1-y). */
  function calibration(pairs, fold) {
    var rows = PROB_BUCKETS.map(function (b) { return { bucket: b[2], lo: b[0], hi: b[1], n: 0, sp: 0, sy: 0 }; });
    var used = [];
    (pairs || []).forEach(function (q) {
      var p = num(q.p), y = q.y; if (!isNum(p) || (y !== 0 && y !== 1)) return;
      if (fold && p < 0.5) { p = 1 - p; y = 1 - y; }
      used.push({ p: p, y: y });
      for (var i = 0; i < rows.length; i++) if (p >= rows[i].lo && p < rows[i].hi) { rows[i].n++; rows[i].sp += p; rows[i].sy += y; break; }
    });
    var N = used.length, ece = 0;
    var out = rows.map(function (b) {
      var o = { bucket: b.bucket, n: b.n, predicted: b.n ? r(b.sp / b.n, 4) : null, observed: b.n ? r(b.sy / b.n, 4) : null, label: sampleLabel(b.n) };
      o.difference = b.n ? r(o.observed - o.predicted, 4) : null;
      if (b.n && N) ece += (b.n / N) * Math.abs(o.observed - o.predicted);
      return o;
    });
    return { n: N, label: sampleLabel(N), buckets: out, ece: N ? r(ece, 4) : null,
      brier: N ? r(mean(used.map(function (u) { return (u.p - u.y) * (u.p - u.y); })), 5) : null,
      slope: N >= 200 ? logisticSlope(used) : null, slope_note: N >= 200 ? null : 'insufficient sample (n < 200)' };
  }
  /* logistic regression y ~ a + b*logit(p) by Newton-Raphson; returns b */
  function logisticSlope(used) {
    var X = used.map(function (u) { var p = clamp(u.p, 1e-4, 1 - 1e-4); return Math.log(p / (1 - p)); });
    var a = 0, b = 1, it, i;
    for (it = 0; it < 50; it++) {
      var g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
      for (i = 0; i < X.length; i++) {
        var z = a + b * X[i], pr = 1 / (1 + Math.exp(-z)), w = pr * (1 - pr), d = used[i].y - pr;
        g0 += d; g1 += d * X[i]; h00 += w; h01 += w * X[i]; h11 += w * X[i] * X[i];
      }
      var det = h00 * h11 - h01 * h01; if (Math.abs(det) < 1e-12) break;
      var da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det;
      a += da; b += db; if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    return r(b, 4);
  }
  function winCalibration(evals) {
    return calibration((evals || []).filter(function (e) { return !e.void && isNum(e.p_home); })
      .map(function (e) { return { p: e.p_home, y: e.home_won }; }), true);
  }
  function coverCalibration(evals) {
    return calibration((evals || []).filter(function (e) { return !e.void && isNum(e.cover_probability) && e.covered !== null && e.covered !== undefined; })
      .map(function (e) { return { p: e.cover_probability, y: e.covered ? 1 : 0 }; }), false);
  }
  function intervalReport(evals) {
    var es = (evals || []).filter(function (e) { return !e.void; });
    var out = {};
    [[50, 0.5], [80, 0.8], [95, 0.95]].forEach(function (k) {
      var xs = es.map(function (e) { return b01(e['in_interval_' + k[0]]); }).filter(isNum);
      var n = xs.length, cov = n ? mean(xs) : null, band = binomBand(k[1], n);
      out['p' + k[0]] = { nominal: k[1], n: n, coverage: r(cov, 4), band: [r(band[0], 4), r(band[1], 4)], label: sampleLabel(n),
        verdict: (n < 30 || cov === null) ? 'insufficient sample' : (cov < band[0] ? 'OVERCONFIDENT' : (cov > band[1] ? 'UNDERCONFIDENT' : 'within band')) };
    });
    return out;
  }
  /* betting summary over evaluations with a side (§11) */
  function betting(evals, opts) {
    opts = opts || {};
    var es = (evals || []).filter(function (e) { return e.side && e.ats_result && e.ats_result !== 'VOID'; });
    var w = 0, l = 0, p = 0, profit = 0, risked = 0, cum = 0, peak = 0, dd = 0;
    var unitsField = opts.hypothetical ? 'hypothetical_units' : 'units';
    es.slice().sort(function (a, b) { return (ms(a.kickoff_ts) || 0) - (ms(b.kickoff_ts) || 0); }).forEach(function (e) {
      if (e.ats_result === 'WIN') w++; else if (e.ats_result === 'LOSS') l++; else if (e.ats_result === 'PUSH') p++;
      var stake = opts.hypothetical ? 1 : (e.stake_units || 0);
      var u = num(e[unitsField]);
      if (stake > 0 && isNum(u)) { profit += u; risked += stake; cum += u; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    });
    var clv = es.map(function (e) { return e.clv_points; }).filter(isNum);
    var pos = es.map(function (e) { return e.positive_clv; }).filter(function (x) { return x === true || x === false; });
    var n = w + l;
    return { decisions: es.length, wins: w, losses: l, pushes: p, ats_pct: n ? r(w / n, 4) : null, label: sampleLabel(n),
      units: r(profit, 3), risked: r(risked, 3), roi: risked ? r(profit / risked, 4) : null, max_drawdown: r(dd, 3),
      clv_n: clv.length, clv_mean: r(mean(clv), 3), clv_median: r(median(clv), 3),
      positive_clv_pct: pos.length ? r(pos.filter(Boolean).length / pos.length, 4) : null,
      price_assumed_share: es.length ? r(es.filter(function (e) { return e.price_assumed; }).length / es.length, 4) : null };
  }
  function marketComparison(evals) {
    var es = (evals || []).filter(function (e) { return !e.void && isNum(e.abs_margin_error); });
    function one(field, beat) {
      var xs = es.filter(function (e) { return isNum(e[field]); });
      var d = xs.map(function (e) { return e.abs_margin_error - e[field]; });
      return { n: xs.length, label: sampleLabel(xs.length), model_mae: r(mean(xs.map(function (e) { return e.abs_margin_error; })), 3),
        market_mae: r(mean(xs.map(function (e) { return e[field]; })), 3), mean_error_diff: r(mean(d), 3), diff_ci: bootMeanCI(d, 2000, 7).map(function (x) { return r(x, 3); }),
        beat_share: xs.length ? r(xs.filter(function (e) { return e[beat] === true; }).length / xs.length, 4) : null,
        tie_share: xs.length ? r(xs.filter(function (e) { return e.abs_margin_error === e[field]; }).length / xs.length, 4) : null };
    }
    var mv = es.filter(function (e) { return e.market_move_toward_model === true || e.market_move_toward_model === false; });
    return { vs_open: one('open_abs_error', 'edgedesk_beat_open'), vs_close: one('close_abs_error', 'edgedesk_beat_close'),
      discovery: { n: mv.length, label: sampleLabel(mv.length), moved_toward_share: mv.length ? r(mv.filter(function (e) { return e.market_move_toward_model; }).length / mv.length, 4) : null,
        mean_move_points: r(mean(mv.map(function (e) { return e.market_move_points; })), 3),
        mean_move_ci: bootMeanCI(mv.map(function (e) { return e.market_move_points; }), 2000, 11).map(function (x) { return r(x, 3); }) } };
  }

  /* ------------------------------------------------ buckets (§15) */
  var BUCKETS = {
    gap: [[0, 1, '0-1'], [1, 2, '1-2'], [2, 3, '2-3'], [3, 4, '3-4'], [4, 5, '4-5'], [5, 7, '5-7'], [7, Infinity, '7+']],
    reliability: [[90, Infinity, '90-100'], [80, 90, '80-89'], [70, 80, '70-79'], [60, 70, '60-69'], [-Infinity, 60, '<60']],
    edge_quality: [[0, 20, '0-19'], [20, 40, '20-39'], [40, 60, '40-59'], [60, 80, '60-79'], [80, Infinity, '80-100']],
    disagreement: [[-Infinity, 1, 'very low'], [1, 2, 'low'], [2, 3, 'moderate'], [3, 4.5, 'high'], [4.5, Infinity, 'very high']]
  };
  function bucketOf(kind, x) {
    if (!isNum(x)) return null;
    var B = BUCKETS[kind]; for (var i = 0; i < B.length; i++) if (x >= B[i][0] && x < B[i][1]) return B[i][2];
    return null;
  }
  function bucketNames(kind) { return BUCKETS[kind].map(function (b) { return b[2]; }); }

  /* ------------------------------------------------ miss review (§17) */
  var MISS_THRESHOLDS = [21, 14, 10];
  function missSeverity(absErr) { if (!isNum(absErr)) return null; for (var i = 0; i < MISS_THRESHOLDS.length; i++) if (absErr >= MISS_THRESHOLDS[i]) return MISS_THRESHOLDS[i]; return null; }
  function classifyMiss(ev) {
    ev = ev || {};
    if (ev.data_quality_status === 'RED' || ev.result_sources_disagree || ev.team_mapping_fault)
      return { classification: 'DATA_FAILURE', rationale: 'snapshot data quality RED, a result-source disagreement or a team-mapping fault' };
    if (ev.qb_changed_from_expected === true)
      return { classification: 'INFORMATION_CHANGE', rationale: 'the starting quarterback differed from the one expected at the snapshot' };
    if (isNum(ev.move_since_snapshot_toward_result) && ev.move_since_snapshot_toward_result >= 3)
      return { classification: 'INFORMATION_CHANGE', rationale: 'the market moved ' + r(ev.move_since_snapshot_toward_result, 1) + ' pts after the snapshot toward the result' };
    var luck = (isNum(ev.turnover_margin_abs) && ev.turnover_margin_abs >= 3) || (isNum(ev.special_teams_swing_abs) && ev.special_teams_swing_abs >= 7) || ev.garbage_time === true;
    if (luck && isNum(ev.close_abs_error) && isNum(ev.abs_error) && ev.close_abs_error >= 0.8 * ev.abs_error)
      return { classification: 'HIGH_VARIANCE_OUTCOME', rationale: 'post-game luck factors present and the close missed by ' + r(ev.close_abs_error, 1) + ' of the model\'s ' + r(ev.abs_error, 1) };
    if (isNum(ev.close_abs_error) && isNum(ev.abs_error) && ev.abs_error - ev.close_abs_error >= 7)
      return { classification: 'MODEL_FAILURE', rationale: 'the close was ' + r(ev.abs_error - ev.close_abs_error, 1) + ' pts closer with no data or information explanation' };
    return { classification: 'UNKNOWN', rationale: 'no rule could be established from the available evidence' };
  }

  /* ------------------------------------------------ drift (§16) */
  function driftAlerts(officialEvalsSorted, ctx) {
    ctx = ctx || {};
    var out = [], es = (officialEvalsSorted || []).filter(function (e) { return !e.void && isNum(e.abs_margin_error); });
    var last50 = es.slice(-50), last100 = es.slice(-100);
    var ref = ctx.reference || {};
    if (last50.length >= 30 && isNum(ref.mae)) {
      var s = errorSummary(last50);
      if (isNum(s.mae_se) && s.mae - ref.mae > 2 * s.mae_se) out.push(alert('mae_rising', 'warn', 'last-' + last50.length + ' MAE ' + s.mae + ' vs reference ' + ref.mae + ' (> 2 SE)', { n: last50.length }));
    }
    if (last100.length >= 50) {
      var wc = winCalibration(last100);
      if (isNum(wc.ece) && wc.ece > 0.06 && last100.length >= 100) out.push(alert('calibration_worse', 'warn', 'last-100 win ECE ' + wc.ece + ' > 0.06', { n: last100.length }));
      var iv = intervalReport(last100).p80;
      if (iv.verdict === 'OVERCONFIDENT' || iv.verdict === 'UNDERCONFIDENT') out.push(alert('calibration_worse', 'warn', '80% intervals ' + iv.verdict.toLowerCase() + ': coverage ' + iv.coverage + ' outside ' + iv.band.join('–') + ' (n=' + iv.n + ')', { n: iv.n }));
      var s2 = errorSummary(last100);
      if (isNum(s2.favorite_bias_se) && Math.abs(s2.favorite_bias) > 2 * s2.favorite_bias_se) out.push(alert('favorite_heavy', 'warn', 'favourite bias ' + s2.favorite_bias + ' (> 2 SE): ' + (s2.favorite_bias < 0 ? 'favourites over-rated' : 'favourites under-rated'), { n: last100.length }));
      if (isNum(ref.pred_var)) {
        var pv = sd(last100.map(function (e) { return e.final_margin - e.margin_error; }));
        var ratio = isNum(pv) ? (pv * pv) / ref.pred_var : null;
        if (isNum(ratio) && (ratio < 0.67 || ratio > 1.5)) out.push(alert('variance_shift', 'warn', 'variance of predicted margins is ' + r(ratio, 2) + 'x the reference', { ratio: r(ratio, 2) }));
      }
    }
    (ctx.extra || []).forEach(function (a) { out.push(a); });
    return out;
  }
  function alert(kind, level, message, detail) { return { kind: kind, level: level, message: message, detail: detail || null }; }

  /* ------------------------------------------------ promotion (§19) */
  function promotionEval(pairs, opts) {
    /* pairs: [{week, champ: eval, chall: eval}] on the common official set */
    opts = opts || {};
    var n = pairs.length, minN = opts.min_n || 150;
    var d = pairs.map(function (p) { return p.chall.abs_margin_error - p.champ.abs_margin_error; });
    var C = pairs.map(function (p) { return p.champ; }), H = pairs.map(function (p) { return p.chall; });
    var sc = errorSummary(C), sh = errorSummary(H), cc = winCalibration(C), ch = winCalibration(H);
    var ci = bootMeanCI(d, 4000, 101);
    var weeks = {}; pairs.forEach(function (p) { (weeks[p.week] = weeks[p.week] || []).push(p); });
    var wk = Object.keys(weeks).map(function (k) { var ps = weeks[k]; return mean(ps.map(function (p) { return p.chall.abs_margin_error - p.champ.abs_margin_error; })) < 0 ? 1 : 0; });
    var cov80 = intervalReport(H).p80.coverage;
    var gates = {
      G1_mae_ci_below_zero: isNum(ci[1]) && ci[1] < 0,
      G2_brier_not_worse: isNum(sh.brier) && isNum(sc.brier) && sh.brier <= sc.brier,
      G3_ece_within_001: isNum(ch.ece) && isNum(cc.ece) && ch.ece <= cc.ece + 0.01,
      G4_coverage80_in_band: isNum(cov80) && cov80 >= 0.75 && cov80 <= 0.85,
      G5_tail_not_worse: isNum(sh.p95_ae) && isNum(sc.p95_ae) && sh.p95_ae <= sc.p95_ae + 1.0,
      G6_weekly_stability: wk.length ? mean(wk) >= 0.6 : false
    };
    var all = Object.keys(gates).every(function (k) { return gates[k]; });
    return { rule: RULES.promotion, n: n, min_n: minN, ready: n >= minN,
      decision: n < minN ? 'INSUFFICIENT_SAMPLE' : (all ? 'ELIGIBLE' : 'NOT_ELIGIBLE'),
      mae_diff: r(mean(d), 3), mae_diff_ci: [r(ci[0], 3), r(ci[1], 3)], weekly_win_share: r(mean(wk), 3), weeks: wk.length,
      champion: { mae: sc.mae, rmse: sc.rmse, brier: sc.brier, ece: cc.ece, p95_ae: sc.p95_ae },
      challenger: { mae: sh.mae, rmse: sh.rmse, brier: sh.brier, ece: ch.ece, p95_ae: sh.p95_ae, coverage_80: cov80 },
      gates: gates, note: 'Eligibility never changes the champion; only governance.js promote does, with an audit entry.' };
  }

  /* ------------------------------------------------ partitions (§20) */
  function poolFor(rec, partitions) {
    /* newest partition event whose scope matches wins */
    var season = num(rec.season), week = num(rec.week), pool = null, at = -Infinity;
    (partitions || []).forEach(function (p) {
      if (num(p.season) !== season) return;
      if (isNum(num(p.week_from)) && week < num(p.week_from)) return;
      if (isNum(num(p.week_to)) && week > num(p.week_to)) return;
      if (p.origin_scope && p.origin_scope !== '*' && p.origin_scope !== rec.origin) return;
      var t = ms(p.effective_at) || 0; if (t >= at) { at = t; pool = p.pool; }
    });
    return pool;
  }
  function canUseForTuning(rec, partitions) { return poolFor(rec, partitions) === 'development_pool'; }

  return {
    RULES: RULES, CHECKPOINTS: CHECKPOINTS, CHECKPOINT_ORDER: CHECKPOINT_ORDER, BUCKETS: BUCKETS, PROB_BUCKETS: PROB_BUCKETS,
    constants: { HEARTBEAT_H: HEARTBEAT_H, CLOSE_ZONE_H: CLOSE_ZONE_H, CLOSE_ZONE_HEARTBEAT_MIN: CLOSE_ZONE_HEARTBEAT_MIN,
      CLOSE_WINDOW_MIN: CLOSE_WINDOW_MIN, CLOSE_GRACE_H: CLOSE_GRACE_H, OPEN_BAND_H: OPEN_BAND_H, CURRENT_MAX_AGE_H: CURRENT_MAX_AGE_H,
      V1_LEAN_GAP: V1_LEAN_GAP, NEAR: NEAR, MISS_THRESHOLDS: MISS_THRESHOLDS },
    util: { isNum: isNum, num: num, r: r, ms: ms, iso: iso, sign: sign, mean: mean, sd: sd, median: median, quantile: quantile,
      iqr: iqr, bootMeanCI: bootMeanCI, rng: rng, normInv: normInv, tExpectedAbs: tExpectedAbs, binomBand: binomBand,
      sampleLabel: sampleLabel, render: render, idParts: idParts },
    conv: conv,
    windowFor: windowFor, dueCheckpoint: dueCheckpoint, familiesFor: familiesFor, isOfficial: isOfficial, hoursToKickoff: hoursToKickoff,
    quoteKey: quoteKey, quoteValues: quoteValues, dedupeDecision: dedupeDecision, quoteRefusal: quoteRefusal, QUOTE_SOURCES: QUOTE_SOURCES, MARKET_TYPES: MARKET_TYPES,
    openerFrom: openerFrom, closeFrom: closeFrom, closeDue: closeDue, marketAt: marketAt,
    payout: payout, impliedProb: impliedProb, toDecimal: toDecimal, fromDecimal: fromDecimal, medianPrice: medianPrice, roundHalfAway: roundHalfAway, atsResult: atsResult, unitsFor: unitsFor, clvPoints: clvPoints, clvPrice: clvPrice,
    decisionClass: decisionClass, v1Decision: v1Decision, thresholdDistance: thresholdDistance, nearMiss: nearMiss,
    dqStatus: dqStatus, confidenceCap: confidenceCap, consensusScore: consensusScore, expectedAbsError: expectedAbsError, impliedSigma: impliedSigma,
    evaluate: evaluate, errorSummary: errorSummary, calibration: calibration, winCalibration: winCalibration, coverCalibration: coverCalibration,
    intervalReport: intervalReport, betting: betting, marketComparison: marketComparison,
    bucketOf: bucketOf, bucketNames: bucketNames,
    missSeverity: missSeverity, classifyMiss: classifyMiss, driftAlerts: driftAlerts, alert: alert,
    promotionEval: promotionEval, poolFor: poolFor, canUseForTuning: canUseForTuning
  };
}));

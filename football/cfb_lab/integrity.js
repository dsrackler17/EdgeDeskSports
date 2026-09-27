/* ============================================================================
   EdgeDesk CFB — market, freshness, settlement and betting integrity rules
   (browser + node, ES5, no dependencies).   docs/cfb-production/MARKET_INTEGRITY.md

   The Model Lab (lab_core.js) defines what the numbers MEAN. This file defines
   when a number may be TRUSTED. Every function is pure: data in, verdict out,
   no clock unless one is passed. The capture feed (supabase/functions/capture),
   the lab job (market.js, checkpoint.js, settle.js), the decision engine
   (football/cfb_decision/decision.js) and the Postgres wrapper
   (supabase/cfb_market_integrity.sql) all apply the same rules, pinned by the
   shared cases in football/cfb_lab/fixtures/integrity_rules.json.

     validateQuote(q, ctx)        impossible values, wrong game, clock faults
                                  -> REJECT (never stored as a market quote;
                                  kept in the quarantine store for investigation)
     screenQuote(q, peers, prev)  robust outlier / movement checks against the
                                  other books and the same book's last number
                                  -> QUARANTINE (kept, never used in consensus)
     crossMarket(quotes)          one book's spread and moneyline disagree about
                                  who is favoured -> QUARANTINE both
     assessMarket(quotes, asOf)   consensus integrity + true freshness
                                  -> OK / DEGRADED / INVALID / MISSING and the
                                  actionable status (ACTIONABLE, MARKET_STALE,
                                  MARKET_DEGRADED, MARKET_INVALID, MARKET_MISSING)
     validFinal(reading)          a FINAL needs a final state and a valid score
     extremeReview(x)             §112/§114: an extreme gap or probability must
                                  pass sign/mapping/QB/injury/freshness/artifact
                                  checks before a BET may stand
     betGate(decisionClass, ...)  fail closed: BET only when every check passes
     betVolume(count, history)    §113: flag (never cancel) an absurd BET count

   SIGNS: home_line < 0 = home favoured (book convention); margin = -home_line.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDCfbIntegrity = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var RULES = {
    quote: 'cfb_market_quote_integrity_v1',
    outlier: 'cfb_market_outlier_v1',
    consensus: 'cfb_market_consensus_integrity_v1',
    freshness: 'cfb_source_freshness_v1',
    settlement: 'cfb_settlement_safety_v1',
    review: 'cfb_extreme_review_v1',
    volume: 'cfb_bet_volume_guard_v1'
  };

  /* Hard bounds. Evidence (docs/cfb-production/MARKET_INTEGRITY.md §2): the raw
     cfbfastR multi-book archive (1,183,529 rows, 2006-2025) has no legitimate
     spread beyond 67.5 (Savannah State @ Florida State, 2012) and 8 junk values
     above 100 (up to 334); totals outside 20-100 are zeros and 200+ junk; 483
     prices sit strictly inside (-100, +100). The bounds are "impossible", not
     "unusual": a legitimate extreme game must never be rejected by them. */
  var BOUNDS = {
    SPREAD_ABS_MAX: 70,
    TOTAL_MIN: 20,
    TOTAL_MAX: 100,
    AMERICAN_ABS_MIN: 100,
    SIDE_PRICE_ABS_MAX: 1000,        /* a two-way spread / total price */
    MONEYLINE_ABS_MAX: 100000,
    TWO_WAY_IMPLIED_MIN: 0.99,       /* one book paying both sides above fair = a broken feed */
    TWO_WAY_IMPLIED_MAX: 1.30,       /* a 30% hold is not a two-way market */
    FUTURE_TOLERANCE_MIN: 5,         /* clock skew allowed between provider and us */
    KICKOFF_MATCH_H: 36,             /* the board's own event-join window */
    MAX_POINTS: 150                  /* no modern college team has scored 150 */
  };
  /* Robust outlier screen (cfb_market_outlier_v1). */
  var OUTLIER = {
    PEER_WINDOW_H: 6,                /* other books' quotes this recent are peers */
    MIN_PEERS_MAD: 3,                /* MAD needs three other books */
    MAD_K: 4,                        /* |x - median| > K * 1.4826 * MAD ... */
    MIN_PTS: { spread: 3.5, total: 5 },          /* ... and more than this many points */
    WIDE_PTS: { spread: 7, total: 10 },          /* with 1-2 peers: disagreement this wide */
    MOVE_PTS: { spread: 10, total: 14 },         /* same book, uncorroborated jump */
    MOVE_WINDOW_H: 48,
    CORROBORATE_PTS: 3,
    SIGN_FLIP_MIN_ABS: 2.5
  };
  /* Consensus integrity (cfb_market_consensus_integrity_v1). */
  var CONSENSUS = {
    MIN_BOOKS: 2,                    /* one book is a quote, not a consensus */
    MAX_STALE_SHARE: 0.5,
    MAX_RANGE_PTS: 3                 /* unresolved disagreement across the books used */
  };
  /* Source freshness (cfb_source_freshness_v1). Every limit here is the one the
     system already enforced somewhere (lab DQ checks METRICS §14, the decision
     policy's stale_minutes, the engine's stale_minutes); this table only puts
     them in one place and makes the decision path read them. */
  var FRESHNESS = {
    odds:      { label: 'odds last updated', importance: 'CRITICAL', max_age_h: function (h) { return (isNum(h) && h <= 48) ? 6 : 36; }, basis: 'METRICS §14 odds_freshness' },
    odds_bet:  { label: 'odds for a live BET', importance: 'CRITICAL', max_age_h: function () { return 3; }, basis: 'decision policy stale_minutes 180 / engine stale_minutes 180' },
    qb:        { label: 'QB status last updated', importance: 'HIGH_VALUE', max_age_h: function () { return 72; }, basis: 'METRICS §14 qb_status_freshness' },
    injury:    { label: 'injury status last updated', importance: 'HIGH_VALUE', max_age_h: function (h) { return (isNum(h) && h <= 72) ? 72 : Infinity; }, basis: 'METRICS §14 injury_freshness' },
    weather:   { label: 'weather last updated', importance: 'OPTIONAL', max_age_h: function (h) { return (isNum(h) && h <= 48) ? 12 : Infinity; }, basis: 'METRICS §14 weather_freshness' },
    pbp:       { label: 'PBP last updated', importance: 'CRITICAL', max_age_h: function () { return 8 * 24; }, basis: 'weekly PBP refresh; a missed week is stale' },
    roster:    { label: 'roster last updated', importance: 'HIGH_VALUE', max_age_h: function () { return 14 * 24; }, basis: 'weekly roster build' },
    schedule:  { label: 'schedule last updated', importance: 'CRITICAL', max_age_h: function () { return 26; }, basis: 'daily schedule build' }
  };
  var EXTREME = {
    GAP_PTS: 10,                     /* decision policy extreme_gap_pts (cfb_decision_policy_v0) */
    /* decision_cover_probability never exceeded 0.60 in 3,633 walk-forward
       development decisions (cfb_decision_calibration_v1 evidence.json:
       cover_buckets_decision, 57.5-60 n=3, 60+ n=0). Above it the number is
       historically unobserved: a diagnostic trigger, not a cap. */
    COVER_PROBABILITY: 0.60,
    QB_CERTAINTY_MIN: 70,
    INJURY_CERTAINTY_MIN: 60,
    FEATURE_MAX_AGE_H: 8 * 24,
    QUOTE_MAX_AGE_MIN: 60
  };
  var VOLUME = { MIN_HISTORY_WEEKS: 3, RATIO: 3, ABS_FLOOR: 10 };

  /* ------------------------------------------------------------ helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  /* strict: a missing value is null, never 0 (Number(null) === 0 is the bug) */
  function num(x) {
    if (x === null || x === undefined || x === '' || typeof x === 'boolean') return null;
    if (typeof x === 'string' && !/^\s*[+-]?(\d+(\.\d*)?|\.\d+)\s*$/.test(x)) return null;
    var n = Number(x); return isFinite(n) ? n : null;
  }
  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function median(xs) {
    xs = (xs || []).filter(isNum).slice().sort(function (a, b) { return a - b; }); if (!xs.length) return null;
    var m = Math.floor(xs.length / 2); return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
  }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 3 : k); return Math.round(x * m) / m; }
  function uniq(a) { var o = [], s = {}; (a || []).forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }
  /* American -> implied probability; null for anything that is not a price */
  function implied(a) {
    a = num(a); if (!isNum(a) || Math.abs(a) < BOUNDS.AMERICAN_ABS_MIN) return null;
    return a > 0 ? 100 / (a + 100) : (-a) / (-a + 100);
  }
  function lineOf(q) { return q.market_type === 'total' ? num(q.total_points) : (q.market_type === 'spread' ? num(q.home_line) : null); }
  function priceCols(q) { return q.market_type === 'total' ? ['price_over', 'price_under'] : ['price_home', 'price_away']; }

  /* ----------------------------------------------- 1. hard quote validity */
  /* ctx: { now, game: {home, away, kickoff}, sameTeam(a, b) -> true|false|null }
     Returns { ok, severity: 'OK'|'REJECT', reasons: [...codes], warnings: [...] }.
     REJECT = the quote is impossible or belongs to another game: it is never a
     market quote. It is kept in the quarantine store (never deleted). */
  function validateQuote(q, ctx) {
    ctx = ctx || {};
    var reasons = [], warnings = [];
    var mt = q && q.market_type;
    if (!q || typeof q !== 'object') return verdict(['NOT_AN_OBJECT'], []);
    /* a value that is present but not a number is a schema fault, not a zero */
    ['home_line', 'total_points', 'price_home', 'price_away', 'price_over', 'price_under'].forEach(function (c) {
      if (present(q[c]) && !isNum(num(q[c]))) reasons.push('NON_NUMERIC_' + c.toUpperCase());
    });
    if (mt === 'spread') {
      var hl = num(q.home_line);
      if (isNum(hl) && Math.abs(hl) > BOUNDS.SPREAD_ABS_MAX) reasons.push('SPREAD_OUT_OF_BOUNDS');
    }
    if (mt === 'total') {
      var tp = num(q.total_points);
      if (isNum(tp) && (tp < BOUNDS.TOTAL_MIN || tp > BOUNDS.TOTAL_MAX)) reasons.push('TOTAL_OUT_OF_BOUNDS');
    }
    /* prices: American 0 is not a price; |a| < 100 is not an American price */
    var cols = mt === 'total' ? ['price_over', 'price_under'] : ['price_home', 'price_away'];
    var maxAbs = mt === 'moneyline' ? BOUNDS.MONEYLINE_ABS_MAX : BOUNDS.SIDE_PRICE_ABS_MAX;
    cols.forEach(function (c) {
      var a = num(q[c]);
      if (!isNum(a)) return;
      if (a === 0) reasons.push('PRICE_ZERO');
      else if (Math.abs(a) < BOUNDS.AMERICAN_ABS_MIN) reasons.push('PRICE_NOT_AMERICAN');
      else if (Math.abs(a) > maxAbs) reasons.push('PRICE_OUT_OF_BOUNDS');
      else if (Math.round(a) !== a) reasons.push('PRICE_NOT_INTEGER');
    });
    var p1 = implied(q[cols[0]]), p2 = implied(q[cols[1]]);
    if (isNum(p1) && isNum(p2)) {
      var s = p1 + p2;
      if (num(q[cols[0]]) === num(q[cols[1]]) && s > BOUNDS.TWO_WAY_IMPLIED_MAX) reasons.push('IDENTICAL_SIDE_PRICES');
      else if (s > BOUNDS.TWO_WAY_IMPLIED_MAX) reasons.push('TWO_WAY_HOLD_TOO_HIGH');
      if (s < BOUNDS.TWO_WAY_IMPLIED_MIN) reasons.push('TWO_WAY_BELOW_FAIR');
    }
    /* clocks */
    var now = ms(ctx.now), obs = ms(q.observed_at), upd = ms(q.provider_updated_at), tol = BOUNDS.FUTURE_TOLERANCE_MIN * 60000;
    if (now !== null && obs !== null && obs > now + tol) reasons.push('OBSERVED_IN_FUTURE');
    if (upd !== null && obs !== null && upd > obs + tol) reasons.push('PROVIDER_TS_AFTER_OBSERVED');
    if (present(q.provider_updated_at) && upd === null) reasons.push('PROVIDER_TS_UNPARSEABLE');
    /* the game: teams (orientation included) and kickoff */
    var g = ctx.game;
    if (g) {
      var same = ctx.sameTeam || defaultSameTeam;
      if (present(q.home_team) && present(q.away_team) && present(g.home) && present(g.away)) {
        var hh = same(q.home_team, g.home), aa = same(q.away_team, g.away);
        var ha = same(q.home_team, g.away), ah = same(q.away_team, g.home);
        if (ha === true && ah === true && !(hh === true && aa === true)) reasons.push('WRONG_GAME_ORIENTATION');
        else if (hh === false || aa === false) reasons.push('WRONG_GAME_TEAMS');
        else if (hh === null || aa === null) warnings.push('TEAM_UNVERIFIED');
      }
      var qk = ms(q.kickoff_ts), gk = ms(g.kickoff);
      if (qk !== null && gk !== null && Math.abs(qk - gk) > BOUNDS.KICKOFF_MATCH_H * 3600000) reasons.push('WRONG_GAME_KICKOFF');
    }
    return verdict(uniq(reasons), uniq(warnings));
  }
  function verdict(reasons, warnings) {
    return { ok: reasons.length === 0, severity: reasons.length ? 'REJECT' : 'OK', reasons: reasons, warnings: warnings || [], rule: RULES.quote };
  }
  function normTeam(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
  /* without an identity resolver: exact normalized equality or nothing (no substrings) */
  function defaultSameTeam(a, b) { var x = normTeam(a), y = normTeam(b); if (!x || !y) return null; return x === y ? true : null; }

  /* ------------------------------------------ 2. robust outlier screening */
  /* q: a candidate ordinary quote (spread or total). peers: stored/accepted
     quotes of the SAME game and market from OTHER (source, book) keys. prev:
     the same key's latest stored ordinary quote (or null). Returns
     { ok, severity: 'OK'|'QUARANTINE', reasons, evidence }. */
  function screenQuote(q, peers, prev, opts) {
    opts = opts || {};
    var mt = q.market_type, x = lineOf(q), reasons = [], ev = {};
    if ((mt !== 'spread' && mt !== 'total') || !isNum(x) || q.is_provider_open || q.is_provider_close) return { ok: true, severity: 'OK', reasons: [], evidence: null, rule: RULES.outlier };
    var t = ms(q.observed_at);
    var win = (opts.peerWindowH || OUTLIER.PEER_WINDOW_H) * 3600000;
    /* each other (source, book): its latest quote within the window, before q */
    var latest = {};
    (peers || []).forEach(function (p) {
      if (!p || p.market_type !== mt || p.is_provider_open || p.is_provider_close) return;
      var k = p.source + ':' + p.book;
      if (k === q.source + ':' + q.book) return;
      var pt = ms(p.observed_at); if (pt === null || t === null || pt > t || t - pt > win) return;
      if (!isNum(lineOf(p))) return;
      if (!latest[k] || ms(latest[k].observed_at) < pt) latest[k] = p;
    });
    var vals = Object.keys(latest).sort().map(function (k) { return lineOf(latest[k]); });
    ev.peers = vals.length;
    if (vals.length) {
      var med = median(vals), mad = median(vals.map(function (v) { return Math.abs(v - med); })) * 1.4826;
      var dev = Math.abs(x - med);
      ev.peer_median = r(med, 3); ev.peer_mad = r(mad, 3); ev.deviation = r(dev, 3);
      if (vals.length >= OUTLIER.MIN_PEERS_MAD) {
        var thr = Math.max(OUTLIER.MIN_PTS[mt], OUTLIER.MAD_K * mad);
        ev.threshold = r(thr, 3);
        if (dev > thr) reasons.push('CROSS_BOOK_OUTLIER');
      } else if (dev > OUTLIER.WIDE_PTS[mt]) { ev.threshold = OUTLIER.WIDE_PTS[mt]; reasons.push('CROSS_BOOK_DISAGREEMENT'); }
    }
    /* the same book's own history: a sign flip, or a huge uncorroborated jump */
    if (prev && isNum(lineOf(prev))) {
      var pv = lineOf(prev), pt2 = ms(prev.observed_at);
      if (pt2 !== null && t !== null && t - pt2 <= OUTLIER.MOVE_WINDOW_H * 3600000) {
        ev.previous = pv; ev.move = r(x - pv, 3);
        var corroborated = vals.some(function (v) { return Math.abs(v - x) <= OUTLIER.CORROBORATE_PTS; });
        if (mt === 'spread' && Math.abs(pv) >= OUTLIER.SIGN_FLIP_MIN_ABS && Math.abs(x + pv) <= 0.5 && Math.abs(x - pv) >= 5 && !corroborated) reasons.push('SIGN_FLIP_SUSPECT');
        else if (Math.abs(x - pv) >= OUTLIER.MOVE_PTS[mt] && !corroborated) reasons.push('UNCORROBORATED_JUMP');
      }
    }
    return { ok: reasons.length === 0, severity: reasons.length ? 'QUARANTINE' : 'OK', reasons: reasons, evidence: ev, rule: RULES.outlier };
  }

  /* One book, one moment: the spread says who is favoured, so must the
     moneyline. quotes: the spread and moneyline rows of one (source, book,
     game, observed_at). Returns the reasons (empty = consistent). */
  function crossMarket(spread, moneyline) {
    if (!spread || !moneyline) return [];
    var hl = num(spread.home_line), ph = implied(moneyline.price_home), pa = implied(moneyline.price_away);
    if (!isNum(hl) || !isNum(ph) || !isNum(pa) || Math.abs(hl) < 3) return [];
    var spreadFav = hl < 0 ? 'HOME' : 'AWAY', mlFav = ph > pa ? 'HOME' : (pa > ph ? 'AWAY' : null);
    return mlFav && mlFav !== spreadFav ? ['CROSS_MARKET_ORIENTATION'] : [];
  }

  /* ---------------------------------------------- 3. freshness + consensus */
  /* A quote's TRUE age: the older of when we saw it and when the provider says
     the book last changed it (a heartbeat of a book that stopped updating is
     not fresh). Future timestamps are not "fresh": they are clock faults. */
  function quoteAgeH(q, now) {
    var t = ms(now), o = ms(q.observed_at), u = ms(q.provider_updated_at);
    if (t === null || o === null) return null;
    var base = (u !== null && u < o) ? u : o;
    return (t - base) / 3600000;
  }
  function freshnessOf(source, asOf, now, hoursToKickoff) {
    var F = FRESHNESS[source];
    if (!F) return { source: source, status: 'UNKNOWN_SOURCE', age_h: null, max_age_h: null };
    var a = ms(asOf), t = ms(now), lim = F.max_age_h(hoursToKickoff);
    if (a === null) return { source: source, status: 'MISSING', age_h: null, max_age_h: lim, importance: F.importance };
    var age = (t - a) / 3600000;
    if (age < -BOUNDS.FUTURE_TOLERANCE_MIN / 60) return { source: source, status: 'CLOCK_FAULT', age_h: r(age, 2), max_age_h: lim, importance: F.importance };
    return { source: source, status: age > lim ? 'STALE' : 'FRESH', age_h: r(age, 2), max_age_h: lim, importance: F.importance };
  }
  /* The market a decision at `asOf` would use (spread): each (source, book)'s
     latest ordinary pregame quote, the same selection lab_core.marketAt makes.
     opts: { kickoff, hoursToKickoff, quarantinedIds: {quote_id: true},
     maxAgeH (default: odds freshness), staleForBetH }. */
  function assessMarket(quotes, asOf, opts) {
    opts = opts || {};
    var t = ms(asOf), k = ms(opts.kickoff), reasons = [];
    var qx = opts.quarantinedIds || {};
    var sp = (quotes || []).filter(function (q) {
      var o = ms(q.observed_at);
      return q.market_type === 'spread' && q.is_pregame !== false && !q.is_provider_open && !q.is_provider_close
        && isNum(num(q.home_line)) && o !== null && t !== null && o <= t && (k === null || o < k);
    });
    var by = {};
    sp.forEach(function (q) { var key = q.source + ':' + q.book; if (!by[key] || ms(by[key].observed_at) < ms(q.observed_at) || (ms(by[key].observed_at) === ms(q.observed_at) && String(q.quote_id) < String(by[key].quote_id))) by[key] = q; });
    var keys = Object.keys(by).sort();
    var per = keys.map(function (x) { return by[x]; });
    var real = per.filter(function (q) { return String(q.book).toLowerCase() !== 'consensus'; });
    var used = real.length ? real : per;
    var out = { rule: RULES.consensus, status: 'OK', actionable_status: 'ACTIONABLE', reasons: reasons, n_books: used.length,
      stale_share: null, newest_true_age_h: null, range_pts: null, invalid_quote_ids: [], quarantined_used: [] };
    if (!used.length) { out.status = 'MISSING'; out.actionable_status = 'MARKET_MISSING'; reasons.push('no pregame spread quote'); return out; }
    /* invalid: a used quote that fails the hard rules or is quarantined */
    used.forEach(function (q) {
      var v = validateQuote(q, { now: asOf });
      if (!v.ok) out.invalid_quote_ids.push(q.quote_id);
      if (qx[q.quote_id]) out.quarantined_used.push(q.quote_id);
    });
    var h = isNum(opts.hoursToKickoff) ? opts.hoursToKickoff : (k !== null && t !== null ? (k - t) / 3600000 : null);
    var lim = isNum(opts.maxAgeH) ? opts.maxAgeH : FRESHNESS.odds.max_age_h(h);
    var ages = used.map(function (q) { return quoteAgeH(q, asOf); }).filter(isNum);
    var staleN = ages.filter(function (a) { return a > lim; }).length;
    out.stale_share = used.length ? r(staleN / used.length, 3) : null;
    out.newest_true_age_h = ages.length ? r(Math.min.apply(null, ages), 3) : null;
    var lines = used.map(function (q) { return num(q.home_line); });
    out.range_pts = r(Math.max.apply(null, lines) - Math.min.apply(null, lines), 3);
    if (out.invalid_quote_ids.length || out.quarantined_used.length) { out.status = 'INVALID'; out.actionable_status = 'MARKET_INVALID'; reasons.push('a quote in the market failed validation or is quarantined'); return out; }
    if (!isNum(out.newest_true_age_h) || out.newest_true_age_h > lim) { out.status = 'DEGRADED'; out.actionable_status = 'MARKET_STALE'; reasons.push('newest quote ' + (isNum(out.newest_true_age_h) ? out.newest_true_age_h.toFixed(1) + ' h' : 'of unknown age') + ' old (limit ' + lim + ' h)'); }
    var betLim = isNum(opts.staleForBetH) ? opts.staleForBetH : FRESHNESS.odds_bet.max_age_h(h);
    out.bet_fresh = isNum(out.newest_true_age_h) && out.newest_true_age_h <= betLim;
    if (out.status === 'OK' && used.length < CONSENSUS.MIN_BOOKS) { out.status = 'DEGRADED'; out.actionable_status = 'MARKET_DEGRADED'; reasons.push(used.length + ' book: below the ' + CONSENSUS.MIN_BOOKS + '-book consensus minimum'); }
    if (out.status === 'OK' && out.stale_share > CONSENSUS.MAX_STALE_SHARE) { out.status = 'DEGRADED'; out.actionable_status = 'MARKET_DEGRADED'; reasons.push(Math.round(out.stale_share * 100) + '% of books stale'); }
    if (out.status === 'OK' && out.range_pts > CONSENSUS.MAX_RANGE_PTS) { out.status = 'DEGRADED'; out.actionable_status = 'MARKET_DEGRADED'; reasons.push('books span ' + out.range_pts + ' pts (unresolved disagreement)'); }
    if (out.status === 'OK' && !out.bet_fresh) { out.actionable_status = 'MARKET_STALE'; reasons.push('newest quote older than the ' + betLim + ' h betting limit'); }
    return out;
  }

  /* ---------------------------------------------------- 4. settlement */
  /* A FINAL reading must carry a final state and a valid score: two integers,
     0..MAX_POINTS, and not a tie (college football has no ties since 1996;
     a tied "final" is a placeholder or a feed fault). Returns null = valid. */
  var NOT_FINAL = /SUSPEND|DELAY|IN_PROGRESS|HALFTIME|END_PERIOD|SCHEDULED|RAIN/i;
  function finalProblem(rd) {
    if (!rd || rd.status !== 'FINAL') return 'not a FINAL reading';
    if (rd.name && NOT_FINAL.test(String(rd.name))) return 'status ' + rd.name + ' is not a final state';
    var hp = rd.home_points, ap = rd.away_points;
    if (!isNum(hp) || !isNum(ap)) return 'a final without both scores';
    if (Math.round(hp) !== hp || Math.round(ap) !== ap) return 'a non-integer score';
    if (hp < 0 || ap < 0 || hp > BOUNDS.MAX_POINTS || ap > BOUNDS.MAX_POINTS) return 'a score outside 0-' + BOUNDS.MAX_POINTS;
    if (hp === ap) return 'a tied final (college football has no ties)';
    return null;
  }
  /* which result a snapshot is graded against. A game played more than
     KICKOFF_MATCH_H away from the kickoff the snapshot predicted was postponed
     for that snapshot: VOID, never a win or a loss. */
  function rescheduled(snapshotKickoff, actualKickoff) {
    var a = ms(snapshotKickoff), b = ms(actualKickoff);
    return a !== null && b !== null && Math.abs(a - b) > BOUNDS.KICKOFF_MATCH_H * 3600000;
  }

  /* ------------------------------------------ 5. extreme review + BET gate */
  /* x: { pure_home_margin, fair_spread_home_line, market_home_line, side,
     cover_probability, home_id, away_id, game_id, quote_game_id, quote_home_team,
     home_team, sameTeam, qb_certainty, injury_certainty, feature_ts, market_age_min,
     now, params_hash, expected_params_hash, model_version, expected_model_version,
     market_integrity }. Returns { required, triggers, ok, failures }. */
  function extremeReview(x) {
    x = x || {};
    var trig = [], fail = [];
    var mu = num(x.pure_home_margin), hl = num(x.market_home_line);
    var gap = isNum(mu) && isNum(hl) ? mu + hl : null;       /* model margin - market margin */
    if (isNum(gap) && Math.abs(gap) >= EXTREME.GAP_PTS) trig.push('EXTREME_GAP');
    var cp = num(x.cover_probability);
    if (isNum(cp) && (cp >= EXTREME.COVER_PROBABILITY || cp <= 1 - EXTREME.COVER_PROBABILITY)) trig.push('EXTREME_COVER_PROBABILITY');
    var out = { rule: RULES.review, required: trig.length > 0, triggers: trig, gap_pts: r(gap, 3), ok: true, failures: fail };
    if (!out.required) return out;
    /* sign: the stored fair line is -margin; the side is the one the gap points to;
       a disagreement that collapses when the market is flipped is a convention fault */
    var fl = num(x.fair_spread_home_line);
    if (isNum(mu) && isNum(fl) && Math.abs(fl + mu) > 1e-6) fail.push('SIGN: fair_spread_home_line is not -pure_home_margin');
    if (isNum(gap) && x.side && gap !== 0 && (gap > 0 ? 'HOME' : 'AWAY') !== x.side) fail.push('SIGN: the side is not the one the model-market gap points to');
    if (isNum(gap) && isNum(mu) && isNum(hl) && Math.abs(gap) > 21 && Math.abs(mu - hl) <= 7) fail.push('SIGN: the market number looks flipped relative to the model');
    /* mapping */
    if (x.home_id != null && x.away_id != null && String(x.home_id) === String(x.away_id)) fail.push('MAPPING: home and away are the same team');
    if (x.quote_game_id != null && x.game_id != null && String(x.quote_game_id) !== String(x.game_id)) fail.push('MAPPING: the quote belongs to game ' + x.quote_game_id);
    if (x.quote_home_team && x.home_team) {
      var s = (x.sameTeam || defaultSameTeam)(x.quote_home_team, x.home_team);
      if (s !== true) fail.push('MAPPING: quote home team ' + x.quote_home_team + ' is not verified as ' + x.home_team);
    }
    /* QB and injuries */
    if (!isNum(num(x.qb_certainty)) || num(x.qb_certainty) < EXTREME.QB_CERTAINTY_MIN) fail.push('QB: starting quarterback not established (certainty ' + (x.qb_certainty == null ? 'unknown' : x.qb_certainty) + ')');
    if (!isNum(num(x.injury_certainty)) || num(x.injury_certainty) < EXTREME.INJURY_CERTAINTY_MIN) fail.push('INJURY: availability not established (certainty ' + (x.injury_certainty == null ? 'unknown' : x.injury_certainty) + ')');
    /* freshness */
    var fa = ms(x.feature_ts), t = ms(x.now);
    if (fa === null || t === null || (t - fa) / 3600000 > EXTREME.FEATURE_MAX_AGE_H) fail.push('FEATURES: football inputs older than ' + EXTREME.FEATURE_MAX_AGE_H + ' h or undated');
    if (!isNum(num(x.market_age_min)) || num(x.market_age_min) > EXTREME.QUOTE_MAX_AGE_MIN || num(x.market_age_min) < -BOUNDS.FUTURE_TOLERANCE_MIN) fail.push('MARKET: the quote is not under ' + EXTREME.QUOTE_MAX_AGE_MIN + ' min old');
    if (x.market_integrity && x.market_integrity.status && x.market_integrity.status !== 'OK') fail.push('MARKET: consensus ' + x.market_integrity.status);
    /* model artifact */
    if (x.expected_params_hash && x.params_hash !== x.expected_params_hash) fail.push('ARTIFACT: params hash is not the one frozen for this model');
    if (x.expected_model_version && x.model_version !== x.expected_model_version) fail.push('ARTIFACT: model version ' + x.model_version + ' is not ' + x.expected_model_version);
    out.ok = fail.length === 0;
    return out;
  }
  /* Fail closed (§46): the official class stays BET only when the market is
     actionable and any required review passed. Returns { decision_class, reason }. */
  function betGate(decisionClass, marketIntegrity, review) {
    if (decisionClass !== 'BET') return { decision_class: decisionClass, reason: null, gated: false };
    if (!marketIntegrity || marketIntegrity.actionable_status !== 'ACTIONABLE')
      return { decision_class: 'PASS', gated: true, reason: 'fail closed: ' + ((marketIntegrity && marketIntegrity.actionable_status) || 'MARKET_UNKNOWN') + (marketIntegrity && marketIntegrity.reasons && marketIntegrity.reasons.length ? ' (' + marketIntegrity.reasons.join('; ') + ')' : '') };
    if (review && review.required && !review.ok)
      return { decision_class: 'PASS', gated: true, reason: 'fail closed: extreme-edge integrity review failed (' + review.failures.join('; ') + ')' };
    return { decision_class: 'BET', reason: null, gated: false };
  }

  /* --------------------------------------------- 6. BET-volume anomaly */
  /* history: BET counts of earlier comparable weeks. Flags (never cancels) a
     count that is absurd against that history: more than RATIO x the history's
     median AND above ABS_FLOOR (or, without enough history, above ABS_FLOOR x 2). */
  function betVolume(count, history) {
    var h = (history || []).filter(isNum), med = median(h);
    var out = { rule: RULES.volume, count: count, history_weeks: h.length, history_median: med, flag: false, action: 'NONE', note: 'a flag asks for review; it never cancels a valid bet' };
    if (!isNum(count)) return out;
    var limit = h.length >= VOLUME.MIN_HISTORY_WEEKS ? Math.max(VOLUME.ABS_FLOOR, VOLUME.RATIO * Math.max(med, 1)) : VOLUME.ABS_FLOOR * 2;
    out.limit = limit;
    if (count > limit) { out.flag = true; out.action = 'REVIEW'; out.message = count + ' BET decisions this week against a limit of ' + limit + (h.length ? ' (history median ' + med + ')' : ' (no history)'); }
    return out;
  }

  return {
    RULES: RULES, BOUNDS: BOUNDS, OUTLIER: OUTLIER, CONSENSUS: CONSENSUS, FRESHNESS: FRESHNESS, EXTREME: EXTREME, VOLUME: VOLUME,
    num: num, implied: implied, validateQuote: validateQuote, screenQuote: screenQuote, crossMarket: crossMarket,
    quoteAgeH: quoteAgeH, freshnessOf: freshnessOf, assessMarket: assessMarket,
    finalProblem: finalProblem, rescheduled: rescheduled, extremeReview: extremeReview, betGate: betGate, betVolume: betVolume,
    defaultSameTeam: defaultSameTeam
  };
}));

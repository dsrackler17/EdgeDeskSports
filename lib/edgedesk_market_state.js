/* ===========================================================================
   EDGEDESK MARKET STATE — what market information exists for a game, whether
   it can be trusted, and which calculations it is allowed to feed.
   docs/market-resilience/README.md

   EdgeDesk's football research never depends on a sportsbook. This file is
   the boundary: it reads whatever quotes were captured (the Model Lab ledger,
   the capture function, a number the owner typed in), checks each one, and
   answers ONE question per game — "what market do we have?" — as one of six
   states:

     LIVE         a fresh, checked sportsbook quote (inside the freshness window)
     CACHED       the last captured quote for this game's current market, shown
                  with its source and capture time, never as a current price
     HISTORICAL   older captures kept for line-movement context only, apart
                  from anything current
     MANUAL       a number the owner entered, with its time, always labelled
     UNAVAILABLE  no trustworthy market information exists
     FAULT        captured information failed a consistency or integrity check

   Each state switches on only the calculations it can support (CAPABILITIES).
   The independent research (projection, matchup, explanation, uncertainty)
   reads none of this and is never switched off by it.

   WHAT THIS FILE NEVER DOES
     - it never invents a market number: a missing value stays null;
     - it never substitutes a model number for a market number;
     - it never calls a quote LIVE outside the freshness window, whatever the
       provider status says;
     - it never lets a quote that failed a check reach a comparison.

   Browser: window.EDMarketState. Node: require('./edgedesk_market_state.js').
   ES5, no dependencies (uses lib/edgedesk_calc.js when present for the
   display-rounded gaps, so a printed gap is always the difference of the two
   printed lines).
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDMarketState = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_market_state_v1';

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function ms(t) { if (t == null) return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  function iso(t) { var x = ms(t); return x == null ? null : new Date(x).toISOString(); }
  function r2(x) { return num(x) == null ? null : Math.round(x * 100) / 100; }
  function r4(x) { return num(x) == null ? null : Math.round(x * 10000) / 10000; }
  function median(xs) {
    var a = (xs || []).filter(function (x) { return num(x) != null; }).sort(function (p, q) { return p - q; });
    if (!a.length) return null;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function freeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { freeze(o[k]); }); }
    return o;
  }
  function calc() {
    var G = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null);
    var K = (G && G.EDCalc) || null;
    if (!K && typeof require === 'function') { try { K = require('./edgedesk_calc.js'); } catch (e) { K = null; } }
    return K;
  }
  function ageText(min) {
    if (num(min) == null) return 'age unknown';
    if (min < 1) return 'just now';
    if (min < 90) return Math.round(min) + ' min old';
    if (min < 48 * 60) return (min / 60).toFixed(min < 600 ? 1 : 0).replace(/\.0$/, '') + ' h old';
    return Math.round(min / 1440) + ' days old';
  }
  function bookLine(v) { if (num(v) == null) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '') + String(Math.round(v * 10) / 10); }

  /* ------------------------------------------------------------- STATES */
  var STATES = {
    LIVE: { key: 'LIVE', label: 'LIVE', tone: 'live', rank: 5,
      means: 'A fresh sportsbook quote that passed every integrity check, captured inside the freshness window.' },
    CACHED: { key: 'CACHED', label: 'CACHED', tone: 'cached', rank: 4,
      means: 'The last captured quote for this game, shown with its source and capture time. It is not a current price.' },
    MANUAL: { key: 'MANUAL', label: 'MANUAL', tone: 'manual', rank: 3,
      means: 'A market number the owner entered by hand, with the time it was entered. Labelled manual everywhere; never treated as a verified sportsbook quote.' },
    HISTORICAL: { key: 'HISTORICAL', label: 'HISTORICAL', tone: 'historical', rank: 2,
      means: 'Older market information kept for research and line-movement context, separate from anything current.' },
    UNAVAILABLE: { key: 'UNAVAILABLE', label: 'MARKET UNAVAILABLE', tone: 'none', rank: 1,
      means: 'No trustworthy market information exists for this game.' },
    FAULT: { key: 'FAULT', label: 'MARKET FAULT', tone: 'fault', rank: 0,
      means: 'Captured market information failed a consistency or integrity check, so it is not compared with anything.' }
  };
  var STATE_KEYS = ['LIVE', 'CACHED', 'MANUAL', 'HISTORICAL', 'UNAVAILABLE', 'FAULT'];

  /* What each state may feed. 'research' = shown as research context with its
     label; true = the normal calculation; false = shown as "Unavailable". The
     independent research engine is not in this table: no state switches it off. */
  var CAPABILITIES = {
    LIVE: { market_number: true, spread_difference: true, total_difference: true, no_vig: true, break_even: true,
      price_ev: 'when_validated', betting_validation: true, line_movement: true },
    CACHED: { market_number: true, spread_difference: 'research', total_difference: 'research', no_vig: false, break_even: false,
      price_ev: false, betting_validation: false, line_movement: true },
    MANUAL: { market_number: true, spread_difference: 'research', total_difference: 'research', no_vig: 'your_price', break_even: 'your_price',
      price_ev: false, betting_validation: false, line_movement: false },
    HISTORICAL: { market_number: 'context', spread_difference: false, total_difference: false, no_vig: false, break_even: false,
      price_ev: false, betting_validation: false, line_movement: true },
    UNAVAILABLE: { market_number: false, spread_difference: false, total_difference: false, no_vig: false, break_even: false,
      price_ev: false, betting_validation: false, line_movement: false },
    FAULT: { market_number: false, spread_difference: false, total_difference: false, no_vig: false, break_even: false,
      price_ev: false, betting_validation: false, line_movement: false }
  };

  /* provider status (the capture job's last attempt): it explains a missing
     or ageing market; it never makes a stale quote fresh or a fresh one stale */
  var PROVIDER = {
    OK: 'The odds provider answered on its last scheduled attempt.',
    TIMEOUT: 'The odds provider timed out on its last attempt.',
    RATE_LIMITED: 'The odds provider refused the last request (HTTP 429). Requests are paused until the back-off ends.',
    QUOTA_EXHAUSTED: 'The odds request quota is exhausted. Live capture is paused until the quota resets; no request is retried.',
    BUDGET_HOLD: 'EdgeDesk’s own request budget held this refresh to protect the quota.',
    OUTAGE: 'The odds provider is failing (circuit open). Capture resumes automatically after the cool-down.',
    DISABLED: 'Live odds capture is switched off (research-only mode).',
    UNKNOWN: 'The provider status was not reported.'
  };
  var PROVIDER_DOWN = { TIMEOUT: 1, RATE_LIMITED: 1, QUOTA_EXHAUSTED: 1, OUTAGE: 1, DISABLED: 1, BUDGET_HOLD: 1 };

  var DEFAULTS = {
    live_minutes: 180,              /* cfb_decision_policy_v1.stale_minutes: a quote older than this is not a price */
    cached_max_minutes: 72 * 60,    /* past this a capture is HISTORICAL: kept for movement context only */
    future_tolerance_minutes: 5,    /* a capture time this far in the future is a clock/data error */
    kickoff_tolerance_hours: 36,    /* a quote whose kickoff differs by more is from another game */
    min_verified_books: 2,          /* independent fresh books needed to call a market VERIFIED */
    sport: 'cfb',
    ranges: {
      cfb: { spread_abs_max: 70, total_min: 25, total_max: 100 },
      nfl: { spread_abs_max: 35, total_min: 25, total_max: 70 }
    },
    spread_outlier_pts: 7,          /* a book this far from the other books' median is excluded (board audit rule) */
    total_outlier_pts: 7,
    spread_dispersion_unverified: 3,
    total_dispersion_unverified: 4,
    /* a lone total this far from EdgeDesk's own fair total, with no second
       source to corroborate it, is held as UNVERIFIED and never compared */
    total_model_gap_suspect: 15,
    overround_min: 0,               /* a two-way price pair below fair cannot be one book's market */
    overround_max: 0.25
  };
  function cfgOf(over) {
    var c = {}, k;
    for (k in DEFAULTS) if (has(DEFAULTS, k)) c[k] = DEFAULTS[k];
    if (over) for (k in over) if (has(over, k) && over[k] != null) c[k] = over[k];
    c.range = (c.ranges && c.ranges[c.sport]) || DEFAULTS.ranges.cfb;
    return c;
  }

  /* -------------------------------------------------------- MARKET KEYS
     Only a full-game main line is a game market. Everything else a provider
     sends under a similar name is refused BY NAME before any number is read:
     a first-half total of 27.5, a team total of 34.5 or an alternate ladder
     rung must never stand as "the total". */
  var GAME_MARKETS = { spread: 'spread', spreads: 'spread', total: 'total', totals: 'total', moneyline: 'moneyline', h2h: 'moneyline' };
  function classifyMarketKey(key) {
    var k = String(key == null ? '' : key).toLowerCase().trim();
    if (!k) return { type: null, reason: 'no market key' };
    if (/^player_|_player_|^batter_|^pitcher_|anytime|_td\b|passing|rushing|receiving/.test(k)) return { type: null, code: 'PLAYER_PROP', reason: 'a player prop is not a game market' };
    if (/team_total|team_totals|totals_home|totals_away|home_total|away_total/.test(k)) return { type: null, code: 'TEAM_TOTAL', reason: 'a team total is one side’s points, not the game total' };
    if (/(_|^)(h1|h2|q1|q2|q3|q4|1h|2h|1q|2q|3q|4q|first_half|second_half|quarter|half|p1|p2|p3)(_|$)/.test(k)) return { type: null, code: 'PERIOD_MARKET', reason: 'a period market (half or quarter) is not the full game' };
    if (/^alternate_|^alt_|_alternate$|alternate/.test(k)) return { type: null, code: 'ALTERNATE_LINE', reason: 'an alternate line is never the main market' };
    if (has(GAME_MARKETS, k)) return { type: GAME_MARKETS[k] };
    return { type: null, code: 'UNKNOWN_MARKET', reason: 'unrecognised market key “' + k + '”' };
  }

  /* ------------------------------------------------------------ NORMALISE
     One canonical quote: home-stated spread (negative = home favoured), full
     game total, American prices, observed_at = first seen at these values,
     confirmed_at = the latest time the same values were seen again. */
  function normalizeQuote(raw) {
    raw = raw || {};
    var mk = classifyMarketKey(raw.market_key != null ? raw.market_key : raw.market_type);
    var q = {
      book: raw.book != null ? String(raw.book) : null, source: raw.source != null ? String(raw.source) : null,
      market_key: raw.market_key != null ? String(raw.market_key) : (raw.market_type != null ? String(raw.market_type) : null),
      market_type: mk.type, market_code: mk.code || null, market_reason: mk.reason || null,
      is_alternate: !!(raw.alternate || raw.is_alternate),
      game_id: raw.game_id != null ? String(raw.game_id) : null, season: num(raw.season), kickoff_ts: raw.kickoff_ts || null,
      home_team: raw.home_team || null, away_team: raw.away_team || null,
      home_line: num(raw.home_line), total: num(raw.total != null ? raw.total : raw.total_points),
      price_home: raw.price_home == null ? null : raw.price_home, price_away: raw.price_away == null ? null : raw.price_away,
      price_over: raw.price_over == null ? null : raw.price_over, price_under: raw.price_under == null ? null : raw.price_under,
      observed_at: iso(raw.observed_at), confirmed_at: iso(raw.confirmed_at || raw.observed_at),
      is_pregame: raw.is_pregame !== false, is_provider_consensus: /consensus/i.test(String(raw.book || '')),
      quote_id: raw.quote_id || null, manual: !!raw.manual, entered_by: raw.entered_by || null, note: raw.note || null
    };
    if (ms(q.confirmed_at) != null && ms(q.observed_at) != null && ms(q.confirmed_at) < ms(q.observed_at)) q.confirmed_at = q.observed_at;
    return q;
  }

  /* An American price: an integer with |x| >= 100. A decimal price (1.91) or
     a fraction read as American is refused, never converted by guesswork. */
  function americanOk(a) {
    if (a == null) return true;
    if (typeof a !== 'number' || !isFinite(a)) return false;
    if (Math.abs(a) < 100) return false;
    if (Math.abs(a) > 100000) return false;
    return Math.round(a) === a;
  }
  function overround(a, b) {
    var K = calc();
    if (!K || a == null || b == null) return null;
    var p = K.noVigTwoWay(a, b);
    return p ? p.overround : null;
  }
  function sameTeam(x, y) {
    if (!x || !y) return null;
    var n = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); };
    var a = n(x), b = n(y);
    return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0;
  }

  /* -------------------------------------------------------- QUOTE CHECKS
     Every check that can be made on ONE quote against the game it claims to
     belong to. Returns {ok, codes[], reasons[]} — ok:false is a REJECT: the
     quote is kept in the audit trail and never reaches a comparison. */
  function checkQuote(q, game, now, cfg) {
    cfg = cfg || cfgOf();
    game = game || {};
    var codes = [], reasons = [];
    function bad(code, why) { codes.push(code); reasons.push(why); }
    var t = ms(q.observed_at), kick = ms(game.kickoff);
    if (q.market_type == null) bad(q.market_code || 'UNKNOWN_MARKET', q.market_reason || 'not a full-game market');
    if (q.is_alternate) bad('ALTERNATE_LINE', 'an alternate line is never the main market');
    if (t == null) bad('NO_TIMESTAMP', 'the quote has no capture time');
    else if (now != null && t > now + cfg.future_tolerance_minutes * 60000) bad('FUTURE_TIMESTAMP', 'captured ' + Math.round((t - now) / 60000) + ' min in the future: a clock or data error');
    if (t != null && kick != null && t >= kick && !q.manual) bad('POST_KICKOFF', 'captured at or after kickoff: not a pregame market');
    if (q.game_id != null && game.game_id != null && String(q.game_id) !== String(game.game_id)) bad('WRONG_GAME_ID', 'the quote belongs to game ' + q.game_id + ', not ' + game.game_id);
    if (q.season != null && num(game.season) != null && q.season !== game.season) bad('WRONG_SEASON', 'the quote is from the ' + q.season + ' season, not ' + game.season + ' (cross-season contamination)');
    var qk = ms(q.kickoff_ts);
    if (qk != null && kick != null && Math.abs(qk - kick) > cfg.kickoff_tolerance_hours * 3600000) bad('WRONG_KICKOFF', 'the quote’s kickoff (' + iso(qk) + ') is more than ' + cfg.kickoff_tolerance_hours + ' h from this game’s (' + iso(kick) + ')');
    if (q.home_team && q.away_team && game.home && game.away) {
      var hh = sameTeam(q.home_team, game.home), aa = sameTeam(q.away_team, game.away);
      var ha = sameTeam(q.home_team, game.away), ah = sameTeam(q.away_team, game.home);
      if (!(hh && aa)) {
        if (ha && ah) bad('ORIENTATION_SWAPPED', 'the provider lists ' + q.home_team + ' as home; EdgeDesk has ' + game.home + ' at home. Its spread sign cannot be read until the orientation is resolved.');
        else bad('TEAM_MISMATCH', 'the quote names ' + q.away_team + ' @ ' + q.home_team + ', not ' + game.away + ' @ ' + game.home);
      }
    }
    var R = cfg.range;
    if (q.market_type === 'spread') {
      if (q.home_line == null) bad('MISSING_LINE', 'a spread quote with no line');
      /* a spread past the bound is a total (or garbage) in the spread field;
         CFB spreads of 40-60 are real (FBS vs FCS), so nothing under the bound is flagged */
      else if (Math.abs(q.home_line) > R.spread_abs_max) bad(Math.abs(q.home_line) >= R.total_min && Math.abs(q.home_line) <= R.total_max ? 'TOTAL_SPREAD_CONFUSION' : 'IMPOSSIBLE_SPREAD',
        'a ' + bookLine(q.home_line) + ' spread is outside any real ' + cfg.sport.toUpperCase() + ' market' + (Math.abs(q.home_line) <= R.total_max ? ' (it reads like a game total)' : ''));
      if (q.home_line != null && Math.round(q.home_line * 2) !== q.home_line * 2 && !q.is_provider_consensus && !q.manual) bad('OFF_INCREMENT', 'a book spread off the half-point grid (' + q.home_line + '): a derived number, not a quote');
    }
    if (q.market_type === 'total') {
      if (q.total == null) bad('MISSING_TOTAL', 'a total quote with no points');
      else if (q.total < R.total_min || q.total > R.total_max) {
        if (Math.abs(q.total) <= R.spread_abs_max && q.total < R.total_min) bad('TOTAL_SPREAD_CONFUSION', 'a total of ' + q.total + ' is below any full-game ' + cfg.sport.toUpperCase() + ' total (' + R.total_min + '–' + R.total_max + '): a spread, team total or period total read as the game total');
        else bad('IMPOSSIBLE_TOTAL', 'a total of ' + q.total + ' is outside any full-game ' + cfg.sport.toUpperCase() + ' total (' + R.total_min + '–' + R.total_max + ')');
      }
    }
    ['price_home', 'price_away', 'price_over', 'price_under'].forEach(function (k) {
      if (!americanOk(q[k])) bad('BAD_ODDS_FORMAT', k + ' = ' + q[k] + ' is not an American price (decimal or fractional odds read as American?)');
    });
    var pairs = q.market_type === 'total' ? [q.price_over, q.price_under] : [q.price_home, q.price_away];
    if (pairs[0] != null && pairs[1] != null && americanOk(pairs[0]) && americanOk(pairs[1])) {
      var ov = overround(pairs[0], pairs[1]);
      if (ov != null && (ov < cfg.overround_min || ov > cfg.overround_max))
        bad('PRICE_ARITHMETIC', 'the two prices imply a ' + (100 * ov).toFixed(1) + '% overround: not one book’s two-way market');
    }
    return { ok: codes.length === 0, codes: codes, reasons: reasons };
  }

  /* ----------------------------------------------------- CROSS-BOOK CHECK
     Over the latest valid quote per book for ONE market type: a book far from
     the others' median is excluded (and logged); books naming opposite
     favourites by a full point or more are a contradiction; wide dispersion
     leaves the market UNVERIFIED. */
  function latestPerBook(quotes) {
    var by = {};
    quotes.forEach(function (q) {
      var k = String(q.book || 'unknown').toLowerCase() + '|' + String(q.source || '').toLowerCase();
      if (q.is_provider_consensus) k = 'consensus|' + String(q.source || '').toLowerCase();
      var t = ms(q.confirmed_at) || ms(q.observed_at);
      if (!by[k] || t > (ms(by[k].confirmed_at) || ms(by[k].observed_at))) by[k] = q;
    });
    /* one sportsbook seen through two feeds counts once: its newest capture */
    var byBook = {};
    Object.keys(by).forEach(function (k) {
      var q = by[k], bk = q.is_provider_consensus ? k : String(q.book || 'unknown').toLowerCase();
      if (!byBook[bk] || (ms(q.confirmed_at) || 0) > (ms(byBook[bk].confirmed_at) || 0)) byBook[bk] = q;
    });
    return Object.keys(byBook).sort().map(function (k) { return byBook[k]; });
  }
  function valueOf(q, type) { return type === 'total' ? q.total : q.home_line; }
  function crossCheck(books, type, cfg) {
    var out = { used: [], excluded: [], codes: [], reasons: [], dispersion: null, contradiction: false };
    var real = books.filter(function (q) { return !q.is_provider_consensus; });
    var pool = real.length ? real : books;    /* a provider consensus is a reference, used only when no book quotes */
    if (real.length && real.length < books.length) books.filter(function (q) { return q.is_provider_consensus; }).forEach(function (q) {
      out.excluded.push({ quote: q, codes: ['PROVIDER_CONSENSUS'], reasons: ['a provider’s consensus is a reference, not a book; it is used only when no book quotes'], severity: 'REFERENCE' });
    });
    var lim = type === 'total' ? cfg.total_outlier_pts : cfg.spread_outlier_pts;
    if (pool.length >= 3) {
      /* against the median of ALL the books (robust to one bad book: two
         agreeing 53.5s beside a 34.5 keep the 53.5s and drop the 34.5) */
      var m = median(pool.map(function (x) { return valueOf(x, type); }));
      pool = pool.filter(function (q) {
        var v = valueOf(q, type);
        if (m != null && Math.abs(v - m) > lim) {
          out.excluded.push({ quote: q, codes: [type === 'total' ? 'TOTAL_OUTLIER' : 'SPREAD_OUTLIER'],
            reasons: [q.book + ' ' + (type === 'total' ? 'total ' + v : bookLine(v)) + ' is ' + Math.abs(v - m).toFixed(1) + ' pts from the books’ median ' + r2(m) + ': excluded as a data error'], severity: 'REJECT' });
          return false;
        }
        return true;
      });
    } else if (pool.length === 2) {
      var d2 = Math.abs(valueOf(pool[0], type) - valueOf(pool[1], type));
      if (d2 > lim) { out.contradiction = true; out.codes.push(type === 'total' ? 'TOTAL_SOURCES_DISAGREE' : 'SPREAD_SOURCES_DISAGREE');
        out.reasons.push('the two sources are ' + d2.toFixed(1) + ' pts apart (' + pool.map(function (q) { return q.book + ' ' + (type === 'total' ? valueOf(q, type) : bookLine(valueOf(q, type))); }).join(' vs ') + '): one of them is wrong and neither can be chosen'); }
    }
    if (type === 'spread' && pool.length >= 2) {
      var favH = pool.filter(function (q) { return q.home_line <= -1; }).length, favA = pool.filter(function (q) { return q.home_line >= 1; }).length;
      if (favH && favA) { out.contradiction = true; out.codes.push('OPPOSITE_FAVORITE'); out.reasons.push('books name opposite favourites by a point or more: a sign reversal or a wrong home/away join'); }
    }
    var vals = pool.map(function (q) { return valueOf(q, type); }).sort(function (a, b) { return a - b; });
    out.dispersion = vals.length > 1 ? r2(vals[vals.length - 1] - vals[0]) : 0;
    /* a contradiction withholds the market type: neither number is chosen,
       and no average of two incompatible numbers is ever printed */
    if (out.contradiction) { out.withheld = pool; pool = []; }
    var dl = type === 'total' ? cfg.total_dispersion_unverified : cfg.spread_dispersion_unverified;
    if (vals.length > 1 && out.dispersion > dl && !out.contradiction) { out.codes.push('BOOK_DISAGREEMENT'); out.reasons.push('the books are ' + out.dispersion.toFixed(1) + ' pts apart (over ' + dl + '): the market is unsettled, not verified'); }
    out.used = pool;
    return out;
  }

  /* ----------------------------------------------------------- CLASSIFY
     x = { game:{game_id, season, kickoff, home, away}, now,
           quotes:[raw quote…], manual:[raw manual entry…],
           provider:{status, checked_at, detail}, model:{home_margin, fair_total},
           config:{…} } */
  function classify(x) {
    x = x || {};
    var cfg = cfgOf(x.config), game = x.game || {}, now = ms(x.now);
    if (now == null) now = Date.now();
    var kick = ms(game.kickoff), started = kick != null && now >= kick;
    var prov = x.provider && x.provider.status ? { status: String(x.provider.status).toUpperCase(), checked_at: iso(x.provider.checked_at), detail: x.provider.detail || null }
      : { status: 'UNKNOWN', checked_at: null, detail: null };
    if (!has(PROVIDER, prov.status)) prov.status = 'UNKNOWN';
    prov.text = PROVIDER[prov.status];
    prov.down = !!PROVIDER_DOWN[prov.status];

    /* 1. every captured quote: normalised, checked, duplicates merged */
    var seen = {}, dup = 0, all = [], rejected = [];
    (x.quotes || []).forEach(function (raw) {
      var q = normalizeQuote(raw);
      var key = [q.book, q.source, q.market_key, q.home_line, q.total, q.price_home, q.price_away, q.price_over, q.price_under, q.observed_at].join('|');
      if (seen[key]) { dup++; return; }
      seen[key] = 1;
      var c = checkQuote(q, game, now, cfg);
      if (!c.ok) {
        /* a quote captured after kickoff is the game's close, not a fault */
        if (c.codes.length === 1 && c.codes[0] === 'POST_KICKOFF') return;
        rejected.push({ quote: q, codes: c.codes, reasons: c.reasons, severity: 'REJECT' });
        return;
      }
      all.push(q);
    });

    /* 2. per market type: latest quote per book, then the cross-book check */
    function marketOf(type) {
      var list = all.filter(function (q) { return q.market_type === type; });
      var books = latestPerBook(list);
      var cc = type === 'moneyline' ? { used: books, excluded: [], codes: [], reasons: [], dispersion: null, contradiction: false } : crossCheck(books, type, cfg);
      var used = cc.used;
      var newest = used.length ? Math.max.apply(null, used.map(function (q) { return ms(q.confirmed_at) || ms(q.observed_at); })) : null;
      var fresh = used.filter(function (q) { return (now - (ms(q.confirmed_at) || ms(q.observed_at))) / 60000 <= cfg.live_minutes; });
      var lines = (fresh.length ? fresh : used).map(function (q) { return valueOf(q, type); });
      return { type: type, all_books: books, used: used, fresh: fresh, excluded: cc.excluded, codes: cc.codes, reasons: cc.reasons,
        dispersion: cc.dispersion, contradiction: cc.contradiction, newest: newest,
        age_minutes: newest == null ? null : Math.max(0, Math.round((now - newest) / 60000)),
        value: type === 'moneyline' ? null : r2(median(lines)), history_n: list.length };
    }
    var S = marketOf('spread'), Tt = marketOf('total'), ML = marketOf('moneyline');

    /* 3. a lone total far from EdgeDesk's own total, with nothing to corroborate it */
    var modelTotal = x.model ? num(x.model.fair_total) : null;
    if (Tt.used.length === 1 && modelTotal != null && Tt.value != null && Math.abs(Tt.value - modelTotal) > cfg.total_model_gap_suspect) {
      var lone = Tt.used[0];
      Tt.excluded.push({ quote: lone, codes: ['TOTAL_UNCORROBORATED'], severity: 'HOLD',
        reasons: ['the only total on file (' + lone.book + ' ' + Tt.value + ') is ' + Math.abs(Tt.value - modelTotal).toFixed(1) + ' pts from EdgeDesk’s fair total ' + modelTotal + ' and no second source corroborates it: held for verification, never compared'] });
      Tt.codes.push('TOTAL_UNCORROBORATED'); Tt.reasons.push(Tt.excluded[Tt.excluded.length - 1].reasons[0]);
      Tt.used = []; Tt.fresh = []; Tt.value = null; Tt.newest = null; Tt.age_minutes = null; Tt.held = true;
    }

    /* 4. manual entries (owner-typed): checked like any quote, never LIVE */
    var manual = (x.manual || []).map(function (m) {
      var q = normalizeQuote({ book: 'manual', source: 'manual', market_key: m.market_type || (num(m.total) != null && num(m.home_line) == null ? 'total' : 'spread'),
        home_line: m.home_line, total: m.total, price_home: m.price_home, price_away: m.price_away, price_over: m.price_over, price_under: m.price_under,
        observed_at: m.entered_at, manual: true, entered_by: m.entered_by || 'owner', note: m.note || null, game_id: m.game_id });
      var c = checkQuote(q, game, now, cfg);
      return { q: q, ok: c.ok, codes: c.codes, reasons: c.reasons };
    });
    manual.filter(function (m) { return !m.ok; }).forEach(function (m) { rejected.push({ quote: m.q, codes: m.codes, reasons: m.reasons, severity: 'REJECT' }); });
    var man = manual.filter(function (m) { return m.ok; }).map(function (m) { return m.q; })
      .sort(function (a, b) { return ms(b.observed_at) - ms(a.observed_at); });
    var manSpread = man.filter(function (q) { return q.home_line != null; })[0] || null;
    var manTotal = man.filter(function (q) { return q.total != null; })[0] || null;

    /* 5. the state */
    var integrityFailures = rejected.concat(S.excluded.filter(function (e) { return e.severity === 'REJECT'; }), Tt.excluded.filter(function (e) { return e.severity === 'REJECT'; }));
    var contradiction = S.contradiction || (Tt.contradiction && !S.used.length);
    var identityFail = rejected.some(function (r) { return /WRONG_GAME_ID|WRONG_SEASON|WRONG_KICKOFF|ORIENTATION_SWAPPED|TEAM_MISMATCH/.test(r.codes.join(' ')); });
    var hasValid = S.used.length || Tt.used.length;
    var state, reason;
    var freshAny = S.fresh.length || Tt.fresh.length;
    var newestAny = Math.max(S.newest || 0, Tt.newest || 0) || null;
    var ageAny = newestAny == null ? null : Math.max(0, Math.round((now - newestAny) / 60000));
    if (contradiction) { state = 'FAULT'; reason = (S.contradiction ? S.reasons : Tt.reasons).filter(Boolean)[0] || 'the captured quotes contradict each other'; }
    else if (!hasValid && rejected.length && !man.length) { state = 'FAULT'; reason = 'every captured quote failed an integrity check: ' + rejected[0].reasons[0]; }
    else if (!hasValid && identityFail && man.length === 0) { state = 'FAULT'; reason = rejected[0].reasons[0]; }
    else if (started && hasValid) { state = 'HISTORICAL'; reason = 'the game has kicked off: the last pregame line is the close, kept for the record and line movement'; }
    else if (freshAny) { state = 'LIVE'; reason = 'captured ' + ageText(ageAny) + ', inside the ' + cfg.live_minutes + '-minute freshness window'; }
    else if (man.length && (!newestAny || ms(man[0].observed_at) >= newestAny)) { state = 'MANUAL'; reason = 'entered by ' + (man[0].entered_by || 'the owner') + ' at ' + man[0].observed_at + '; no fresh sportsbook quote is on file'; }
    else if (hasValid && ageAny != null && ageAny <= cfg.cached_max_minutes) { state = 'CACHED'; reason = 'the last captured line is ' + ageText(ageAny) + ' (past the ' + cfg.live_minutes + '-minute window): a stored capture, not a current price'; }
    else if (hasValid) { state = 'HISTORICAL'; reason = 'the newest capture is ' + ageText(ageAny) + ': kept for line-movement context only'; }
    else if (man.length) { state = 'MANUAL'; reason = 'entered by ' + (man[0].entered_by || 'the owner') + ' at ' + man[0].observed_at; }
    else { state = 'UNAVAILABLE'; reason = rejected.length ? 'no quote survived the integrity checks' : 'no sportsbook quote has been captured for this game'; }
    if (state === 'UNAVAILABLE' && prov.down) reason += ' · ' + prov.text;

    /* 6. what the state exposes: the comparison numbers, never a fault's */
    var compare = state === 'LIVE' || state === 'CACHED' || state === 'MANUAL';
    function side(M, manQ, type) {
      if (state === 'MANUAL' && manQ) {
        return { available: true, value: type === 'total' ? manQ.total : manQ.home_line, basis: 'MANUAL', books: 0, sources: ['manual'],
          captured_at: manQ.observed_at, age_minutes: Math.max(0, Math.round((now - ms(manQ.observed_at)) / 60000)),
          prices: type === 'total' ? { over: manQ.price_over, under: manQ.price_under } : { home: manQ.price_home, away: manQ.price_away },
          dispersion: null, quotes: [manQ] };
      }
      if (!compare || !M.used.length || M.value == null) return { available: false, value: null, reason: M.held ? M.reasons[M.reasons.length - 1]
        : (state === 'FAULT' ? 'withheld: the market failed an integrity check' : (state === 'HISTORICAL' ? 'only historical captures (line-movement context)' : 'no ' + type + ' captured')) };
      var use = M.fresh.length ? M.fresh : M.used;
      var newest = Math.max.apply(null, use.map(function (q) { return ms(q.confirmed_at) || ms(q.observed_at); }));
      var priced = use.filter(function (q) { return type === 'total' ? (q.price_over != null && q.price_under != null) : (q.price_home != null && q.price_away != null); });
      var best = priced.length ? priced.slice().sort(function (a, b) { return (ms(b.confirmed_at) || 0) - (ms(a.confirmed_at) || 0); })[0] : null;
      return { available: true, value: M.value, basis: M.fresh.length ? 'LIVE' : 'CACHED', books: use.filter(function (q) { return !q.is_provider_consensus; }).length,
        provider_consensus_only: use.every(function (q) { return q.is_provider_consensus; }),
        sources: use.map(function (q) { return (q.source || '?') + ':' + (q.book || '?'); }),
        captured_at: iso(newest), first_seen_at: iso(Math.max.apply(null, use.map(function (q) { return ms(q.observed_at); }))),
        age_minutes: Math.max(0, Math.round((now - newest) / 60000)), dispersion: M.dispersion,
        prices: best ? (type === 'total' ? { over: best.price_over, under: best.price_under, book: best.book } : { home: best.price_home, away: best.price_away, book: best.book }) : null,
        quotes: use };
    }
    var spread = side(S, manSpread, 'spread'), total = side(Tt, manTotal, 'total');
    if (state === 'LIVE') {
      /* a LIVE state is per market: a total that is not itself fresh is CACHED context */
      if (spread.available && spread.basis !== 'LIVE') spread.basis = 'CACHED';
      if (total.available && total.basis !== 'LIVE') total.basis = 'CACHED';
    }

    /* 7. integrity: PASS / WARN / FAIL with every check that fired */
    var warn = [].concat(S.codes, Tt.codes).filter(function (c) { return c === 'BOOK_DISAGREEMENT' || c === 'TOTAL_UNCORROBORATED'; });
    var integrity = { status: state === 'FAULT' ? 'FAIL' : (integrityFailures.length || warn.length ? 'WARN' : 'PASS'),
      failures: integrityFailures.map(function (e) { return { book: e.quote.book, source: e.quote.source, market_key: e.quote.market_key,
        home_line: e.quote.home_line, total: e.quote.total, observed_at: e.quote.observed_at, codes: e.codes, reasons: e.reasons }; }),
      held: Tt.excluded.filter(function (e) { return e.severity === 'HOLD'; }).map(function (e) { return { book: e.quote.book, total: e.quote.total, codes: e.codes, reasons: e.reasons }; }),
      references: S.excluded.concat(Tt.excluded).filter(function (e) { return e.severity === 'REFERENCE'; }).map(function (e) { return { book: e.quote.book, source: e.quote.source, value: e.quote.home_line != null ? e.quote.home_line : e.quote.total, reasons: e.reasons }; }),
      warnings: [].concat(S.reasons, Tt.reasons).filter(Boolean),
      checks_fired: [].concat(S.codes, Tt.codes).filter(function (c, i, a) { return a.indexOf(c) === i; }),
      duplicates_merged: dup,
      rules: ['market key (full-game main line only)', 'game id, season, kickoff and home/away', 'spread and total ranges', 'total/spread confusion',
        'American odds format', 'two-way price arithmetic', 'cross-book outliers and opposite favourites', 'book dispersion', 'lone total vs EdgeDesk’s total'] };

    /* 8. the verification of the quote itself (Market Integrity axis) */
    var verified = state === 'LIVE' && spread.available && spread.basis === 'LIVE' && spread.books >= cfg.min_verified_books
      && integrity.status === 'PASS' && (spread.dispersion == null || spread.dispersion <= cfg.spread_dispersion_unverified);

    var st = STATES[state];
    var out = {
      version: VERSION, state: state, label: st.label, tone: st.tone, means: st.means, reason: reason,
      captured_at: state === 'MANUAL' ? (man[0] ? man[0].observed_at : null) : (newestAny ? iso(newestAny) : null),
      age_minutes: state === 'MANUAL' ? (man[0] ? Math.max(0, Math.round((now - ms(man[0].observed_at)) / 60000)) : null) : ageAny,
      age_text: state === 'MANUAL' ? (man[0] ? 'entered ' + ageText(Math.max(0, Math.round((now - ms(man[0].observed_at)) / 60000))).replace(' old', ' ago') : null) : (ageAny == null ? null : ageText(ageAny)),
      sources: spread.available ? spread.sources : (total.available ? total.sources : []),
      spread: spread, total: total,
      moneyline: ML.used.length && compare && state !== 'MANUAL' ? { available: true, quotes: ML.used.map(function (q) { return { book: q.book, home: q.price_home, away: q.price_away, captured_at: q.confirmed_at }; }) } : { available: false },
      verified: verified,
      integrity: integrity, capabilities: CAPABILITIES[state], provider: prov,
      manual_entries: man.map(function (q) { return { home_line: q.home_line, total: q.total, entered_at: q.observed_at, entered_by: q.entered_by, note: q.note }; }),
      history: { spread_quotes: S.history_n, total_quotes: Tt.history_n },
      freshness_rule: 'LIVE inside ' + cfg.live_minutes + ' min of the latest confirmation; CACHED to ' + Math.round(cfg.cached_max_minutes / 60) + ' h; HISTORICAL beyond, or once the game kicks off',
      generated_at: iso(now)
    };
    return freeze(out);
  }

  /* ------------------------------------------------- COMPARISON NUMBERS
     Model vs market, ONLY for a state whose capabilities allow it. Every
     value that cannot be supported is null with the reason; never zero. */
  function compare(snapshot, model, names) {
    snapshot = snapshot || {};
    model = model || {};
    names = names || {};
    var cap = snapshot.capabilities || CAPABILITIES.UNAVAILABLE, K = calc();
    var out = { state: snapshot.state || 'UNAVAILABLE', basis_label: basisLabel(snapshot), spread: null, total: null, no_vig: null, break_even: null, unavailable: [] };
    var mm = num(model.home_margin), mt = num(model.fair_total);
    if (cap.spread_difference && snapshot.spread && snapshot.spread.available && mm != null && K) {
      var c = K.spreadComparison({ home: names.home, away: names.away, model_home_margin: mm, market_home_margin: -snapshot.spread.value });
      out.spread = { available: true, model_text: c.model.text, market_text: c.market.text, gap: c.gap, gap_exact: c.gap_exact, signed: c.signed,
        toward: c.toward, toward_team: c.toward_team, favorite_differs: c.favorite_differs, text: c.text, formula: c.reconcile ? c.reconcile.formula : null,
        market_home_line: snapshot.spread.value, market_basis: snapshot.spread.basis, research_only: cap.spread_difference === 'research' };
    } else out.unavailable.push({ key: 'spread_difference', reason: reasonFor(snapshot, 'spread', mm == null ? 'no EdgeDesk projection' : null) });
    if (cap.total_difference && snapshot.total && snapshot.total.available && mt != null && K) {
      var t = K.totalComparison({ model_total: mt, market_total: snapshot.total.value });
      out.total = { available: true, model: t.model, market: t.market, gap: t.gap, signed: t.signed, direction: t.direction, text: t.text,
        formula: t.reconcile ? t.reconcile.formula : null, market_basis: snapshot.total.basis, research_only: cap.total_difference === 'research' };
    } else out.unavailable.push({ key: 'total_difference', reason: reasonFor(snapshot, 'total', mt == null ? 'no EdgeDesk fair total' : null) });
    var pr = snapshot.spread && snapshot.spread.available ? snapshot.spread.prices : null;
    if (cap.no_vig && pr && pr.home != null && pr.away != null && K) {
      var nv = K.noVigTwoWay(pr.home, pr.away);
      out.no_vig = nv ? { home: r4(nv.a), away: r4(nv.b), overround: r4(nv.overround), book: pr.book || null,
        your_price: cap.no_vig === 'your_price' } : null;
    }
    if (!out.no_vig) out.unavailable.push({ key: 'no_vig', reason: cap.no_vig ? 'no two-sided price at one line' : reasonFor(snapshot, 'price') });
    if (cap.break_even && pr && pr.home != null && pr.away != null && K) {
      out.break_even = { home: r4(K.breakEven(K.decimalFromAmerican(pr.home))), away: r4(K.breakEven(K.decimalFromAmerican(pr.away))), book: pr.book || null, your_price: cap.break_even === 'your_price' };
    } else out.unavailable.push({ key: 'break_even', reason: cap.break_even ? 'no priced quote' : reasonFor(snapshot, 'price') });
    if (cap.price_ev !== 'when_validated') out.unavailable.push({ key: 'price_ev', reason: reasonFor(snapshot, 'price') });
    return freeze(out);
  }
  function basisLabel(s) {
    if (!s || !s.state) return 'Market unavailable';
    switch (s.state) {
      case 'LIVE': return 'Live market' + (s.age_text ? ' · ' + s.age_text : '');
      case 'CACHED': return 'Cached market · last captured ' + (s.age_text || '') + ' · not a current price';
      case 'MANUAL': return 'Manual entry · ' + (s.age_text || '') + ' · not a verified sportsbook quote';
      case 'HISTORICAL': return 'Historical line only · context, not a current price';
      case 'FAULT': return 'Market fault · withheld from every comparison';
      default: return 'Market unavailable';
    }
  }
  function reasonFor(s, what, extra) {
    if (extra) return extra;
    var st = s && s.state;
    if (st === 'FAULT') return 'Unavailable: the market failed an integrity check (' + (s.reason || '') + ')';
    if (st === 'HISTORICAL') return 'Unavailable: only a historical line is on file';
    if (st === 'UNAVAILABLE' || !st) return 'Unavailable: no market captured' + (s && s.provider && s.provider.down ? ' (' + s.provider.status.toLowerCase().replace(/_/g, ' ') + ')' : '');
    if (what === 'price') {
      if (st === 'CACHED') return 'Unavailable: price calculations need a live quote (the cached line is ' + (s.age_text || 'old') + ')';
      if (st === 'MANUAL') return 'Unavailable: a manual number is research context, not a priced quote';
    }
    if (what === 'total' && s.total && !s.total.available) return 'Unavailable: ' + (s.total.reason || 'no total captured');
    if (what === 'spread' && s.spread && !s.spread.available) return 'Unavailable: ' + (s.spread.reason || 'no spread captured');
    return 'Unavailable';
  }

  return freeze({
    VERSION: VERSION, STATES: STATES, STATE_KEYS: STATE_KEYS, CAPABILITIES: CAPABILITIES, PROVIDER: PROVIDER, DEFAULTS: DEFAULTS,
    classifyMarketKey: classifyMarketKey, normalizeQuote: normalizeQuote, checkQuote: function (q, g, now, c) { return checkQuote(normalizeQuote(q), g, ms(now), cfgOf(c)); },
    classify: classify, compare: compare, basisLabel: basisLabel, ageText: ageText
  });
}));

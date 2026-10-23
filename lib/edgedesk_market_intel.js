/* ===========================================================================
   EDGEDESK MARKET INTELLIGENCE — what the market did around one game, said
   only as far as the data supports it. docs/market-intelligence/MASTER_PLAN.md §3

   One function, analyze(), reads the quotes EdgeDesk captured for a game
   (any sport, any source), checks each one at the same boundary the research
   terminal uses (lib/edgedesk_market_state.js normalizeQuote / checkQuote),
   and returns FINDINGS of nine kinds:

     MARKET_CONVERGENCE              the market moved toward EdgeDesk's number
                                     after EdgeDesk published it
     MARKET_DIVERGENCE               the market moved away from it
     UNUSUAL_PRICE_MOVEMENT          a move larger than the historical 95th
                                     percentile of moves (games before this one)
     SOURCE_DISAGREEMENT             two sources, seen within 30 minutes of each
                                     other, on different numbers
     DERIVATIVE_RELATIONSHIP_ANOMALY one book's moneyline and its own spread
                                     disagree by more than its usual relationship
     MODEL_CALIBRATION_WARNING       the game is in a slice where EdgeDesk's own
                                     validation found the model biased
     RULE_DEFINITION_CONFLICT        the model's number and the market settle on
                                     different outcomes (regulation vs overtime)
     STALE_MARKET_DATA               the newest pregame quote is past the
                                     freshness limit
     INCOMPLETE_MARKET_DATA          a market or one side of it is missing, or a
                                     captured quote failed a check

   Every kind has a written eligibility rule (RULES); a kind that cannot be
   evaluated is returned in not_eligible with the reason, never guessed. Every
   finding carries the seven-part explanation (what changed, what we observed,
   what the model says, what the market says, what we can verify, what remains
   uncertain, what historical data suggests), built only from computed numbers
   and the sources that produced them.

   WHAT THIS FILE NEVER DOES
     - it never calls a finding a bet, an edge or a pick;
     - it never says who moved a line or why: a public price moving is not
       evidence of informed money, and no wording here implies it (NO_MYTH);
     - it never reads a quote observed at or after the start;
     - it never treats one sportsbook seen through two feeds as two sources;
     - it never fills a missing number: missing stays missing, and says so.

   Browser: window.EDMarketIntel (load lib/edgedesk_market_state.js and
   lib/edgedesk_calc.js first). Node: require('./edgedesk_market_intel.js').
   ES5, deterministic.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDMarketIntel = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_market_intel_v1';
  var MS = null, K = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) {
    try { MS = require('./edgedesk_market_state.js'); } catch (e) { MS = null; }
    try { K = require('./edgedesk_calc.js'); } catch (e2) { K = null; }
  }
  function ms_() { var m = MS || (root && root.EDMarketState); if (!m) throw new Error('EDMarketIntel needs lib/edgedesk_market_state.js'); return m; }
  function calc() { var c = K || (root && root.EDCalc); if (!c) throw new Error('EDMarketIntel needs lib/edgedesk_calc.js'); return c; }

  /* ------------------------------------------------------------ the kinds */
  var TYPES = {
    MARKET_CONVERGENCE: { label: 'Market convergence', severity: 'info',
      means: 'After EdgeDesk published its number, the market moved toward it.' },
    MARKET_DIVERGENCE: { label: 'Market divergence', severity: 'info',
      means: 'After EdgeDesk published its number, the market moved away from it.' },
    UNUSUAL_PRICE_MOVEMENT: { label: 'Unusual price movement', severity: 'notable',
      means: 'The market moved further than it does in 95% of earlier games in this sport.' },
    SOURCE_DISAGREEMENT: { label: 'Source disagreement', severity: 'notable',
      means: 'Two independent sources, seen within 30 minutes of each other, carry different numbers.' },
    DERIVATIVE_RELATIONSHIP_ANOMALY: { label: 'Moneyline and spread disagree', severity: 'notable',
      means: 'One book\'s moneyline and its own spread imply different win probabilities, by more than that book\'s usual relationship.' },
    MODEL_CALIBRATION_WARNING: { label: 'Model calibration warning', severity: 'caution',
      means: 'EdgeDesk\'s own validation found the model biased in games like this one.' },
    RULE_DEFINITION_CONFLICT: { label: 'Rule definition conflict', severity: 'caution',
      means: 'The model\'s number and the market settle on different outcomes, so they are not compared.' },
    STALE_MARKET_DATA: { label: 'Stale market data', severity: 'caution',
      means: 'The newest pregame quote is older than the freshness limit.' },
    INCOMPLETE_MARKET_DATA: { label: 'Incomplete market data', severity: 'caution',
      means: 'A market or one side of it is missing, or a captured quote failed a check.' }
  };
  var TYPE_KEYS = Object.keys(TYPES);

  /* ------------------------------------------- eligibility, fixed in code
     Engineering choices, written down before any finding is counted. None is
     fitted to outcomes; tools/market_intel/market_intel_backtest.js measures
     what each one was worth afterwards. */
  var RULES = {
    stale_minutes: 180,                       /* = edgedesk_market_state live_minutes */
    movement_min_hours: 1,                    /* two quotes this far apart before a movement is read */
    move_threshold: { spread: 1.0, total: 1.0, moneyline: 0.03 },      /* points; probability */
    disagreement_threshold: { spread: 1.0, total: 1.5, moneyline: 0.03 },
    disagreement_window_minutes: 30,
    unusual_percentile: 0.95,
    unusual_min_history: 100,                 /* earlier games' moves needed to say "unusual" */
    derivative_z: 3,
    derivative_min_fit: 200,                  /* earlier (spread, moneyline) pairs needed to fit the relationship */
    markets: ['spread', 'total', 'moneyline']
  };

  /* No wording that implies who bet or why, or that a finding is a wager. */
  var NO_MYTH = /\b(sharps?|steam(ed|ing)?|smart money|syndicates?|wise ?guys?|professional (money|action|bettors?)|public money|liabilit(y|ies)|locks?|guarantee[ds]?|sure thing|free money|best bet|bet now|hammer|smash|value bet|edges?|picks?|\+ev|positive expected value)\b/i;
  function clean(s) { if (NO_MYTH.test(s)) throw new Error('market intel wording refused: ' + s); return s; }

  /* -------------------------------------------------------------- helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function r1(x) { return isNum(x) ? Math.round(x * 10) / 10 : null; }
  function r3(x) { return isNum(x) ? Math.round(x * 1000) / 1000 : null; }
  function stamp(t) { var s = iso(t); return s ? s.slice(0, 16).replace('T', ' ') + 'Z' : 'unknown time'; }
  function line(v) { if (!isNum(v)) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '') + r1(v); }
  function pct(p) { return isNum(p) ? (100 * p).toFixed(1) + '%' : '—'; }
  function bookKey(b) { return String(b == null ? 'unknown' : b).toLowerCase().replace(/^record:/, '').replace(/[^a-z0-9]+/g, '') || 'unknown'; }
  function logit(p) { return Math.log(p / (1 - p)); }
  /* FNV-1a over a canonical string: a stable finding id, so a re-run adds nothing */
  function fnv(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995, i, c;
    for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0; h2 ^= c; h2 = Math.imul(h2, 2246822519) >>> 0; }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /* The value a quote carries for a market, on one scale per market: the HOME
     margin for a spread (minus the home line), points for a total, the no-vig
     home probability for a moneyline. */
  function valueOf(q, market) {
    if (market === 'spread') return isNum(q.home_line) ? -q.home_line : null;
    if (market === 'total') return isNum(q.total) ? q.total : null;
    if (market === 'moneyline') { var p = calc().noVigTwoWay(q.price_home, q.price_away); return p ? p.a : null; }
    return null;
  }
  function modelValue(model, market) {
    if (!model) return null;
    if (market === 'spread') return num(model.home_margin);
    if (market === 'total') return num(model.fair_total);
    if (market === 'moneyline') return num(model.p_home);
    return null;
  }
  function fmtValue(v, market) {
    if (market === 'spread') return 'home ' + line(isNum(v) ? -v : null);
    if (market === 'total') return isNum(v) ? 'total ' + r1(v) : 'total —';
    return 'home ' + pct(v) + ' (no-vig)';
  }
  function fmtModel(v, market) {
    if (market === 'spread') return isNum(v) ? 'home by ' + r1(v) + ' (fair home line ' + line(-v) + ')' : '—';
    if (market === 'total') return isNum(v) ? 'fair total ' + r1(v) : '—';
    return 'home win ' + pct(v);
  }
  function srcName(q) { return (q.book || 'unknown book') + (q.source ? ' via ' + q.source : ''); }

  /* ---------------------------------------------------- the quote series
     Every raw quote normalised and checked against the game; the accepted
     ones grouped by market and by sportsbook (one key however it is spelled),
     oldest first. A quote at or after the start, or after `now`, is never read. */
  function series(quotes, game, now) {
    var M = ms_(), start = ms(game.kickoff), accepted = [], rejected = [], seen = {};
    (quotes || []).forEach(function (raw) {
      var q = M.normalizeQuote(raw), t = ms(q.observed_at);
      var key = [bookKey(q.book), q.source, q.market_type, q.home_line, q.total, q.price_home, q.price_away, q.price_over, q.price_under, q.observed_at].join('|');
      if (seen[key]) return;
      seen[key] = 1;
      if (t != null && ((start != null && t >= start) || (now != null && t > now))) return;   /* not pregame, or not yet seen */
      var c = M.checkQuote(q, game, now, null);
      if (!c.ok) { rejected.push({ quote: q, codes: c.codes, reasons: c.reasons }); return; }
      accepted.push(q);
    });
    var by = {};
    accepted.forEach(function (q) {
      var m = q.market_type, b = bookKey(q.book);
      by[m] = by[m] || {};
      (by[m][b] = by[m][b] || []).push(q);
    });
    Object.keys(by).forEach(function (m) { Object.keys(by[m]).forEach(function (b) { by[m][b].sort(function (x, y) { return ms(x.observed_at) - ms(y.observed_at); }); }); });
    return { by: by, accepted: accepted, rejected: rejected };
  }
  function latestAtOrBefore(list, t) {
    var best = null;
    (list || []).forEach(function (q) { var qt = ms(q.observed_at); if (qt != null && (t == null || qt <= t) && (!best || qt >= ms(best.observed_at))) best = q; });
    return best;
  }

  /* -------------------------------------------- the derivative relationship
     One book's spread and moneyline observed in the same capture: on the
     logit scale the no-vig home probability is close to linear in the home
     margin the spread implies. fitDerivative fits that line (OLS) and its
     residual sd from pairs the caller supplies (earlier games only). */
  function derivativePairs(quotes) {
    var groups = {};
    (quotes || []).forEach(function (q) {
      var k = bookKey(q.book) + '|' + (q.game_id || q.event_key || '') + '|' + iso(q.observed_at);
      var g = groups[k] = groups[k] || {};
      var mt = q.market_type || (q.market_key === 'h2h' ? 'moneyline' : q.market_key);
      g[mt] = q;
    });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (!g.spread || !g.moneyline || !isNum(num(g.spread.home_line))) return;
      var p = calc().noVigTwoWay(num(g.moneyline.price_home), num(g.moneyline.price_away));
      if (!p || !(p.a > 0.005 && p.a < 0.995)) return;
      out.push({ margin: -num(g.spread.home_line), y: logit(p.a), observed_at: iso(g.spread.observed_at), book: bookKey(g.spread.book) });
    });
    return out;
  }
  function fitDerivative(pairs) {
    var xs = (pairs || []).filter(function (p) { return isNum(p.margin) && isNum(p.y); });
    var n = xs.length;
    if (n < 3) return { n: n, a: null, b: null, sd: null };
    var mx = 0, my = 0;
    xs.forEach(function (p) { mx += p.margin; my += p.y; });
    mx /= n; my /= n;
    var sxx = 0, sxy = 0;
    xs.forEach(function (p) { sxx += (p.margin - mx) * (p.margin - mx); sxy += (p.margin - mx) * (p.y - my); });
    if (!(sxx > 0)) return { n: n, a: null, b: null, sd: null };
    var b = sxy / sxx, a = my - b * mx, ss = 0;
    xs.forEach(function (p) { var e = p.y - a - b * p.margin; ss += e * e; });
    return { n: n, a: a, b: b, sd: n > 2 ? Math.sqrt(ss / (n - 2)) : null };
  }
  function sigm(z) { return 1 / (1 + Math.exp(-z)); }

  /* ------------------------------------------------------------ findings */
  function finding(type, ctx, body) {
    var T = TYPES[type];
    var ex = body.explain;
    ['what_changed', 'what_we_observed', 'what_the_model_says', 'what_the_market_says', 'what_we_can_verify', 'what_remains_uncertain', 'what_historical_data_suggests']
      .forEach(function (k) { ex[k] = clean(String(ex[k] == null ? 'Not available.' : ex[k])); });
    var id = 'mi_' + fnv([ctx.event_key, type, body.market || '', JSON.stringify(body.key || body.evidence)].join('|'));
    return {
      finding_id: id, version: VERSION, type: type, label: T.label, means: T.means,
      severity: body.severity || T.severity, sport: ctx.sport, event_key: ctx.event_key, market: body.market || null,
      as_of: iso(ctx.now), start: iso(ctx.start), model_version: ctx.model ? ctx.model.model_version || null : null,
      eligibility: body.eligibility, evidence: body.evidence, importance: body.importance || null,
      explain: ex, sources: body.sources || [], provenance_tier: body.tier || 'T2_COMPUTED'
    };
  }
  function sourceRef(q) { return { book: q.book || null, source: q.source || null, observed_at: iso(q.observed_at), quote_id: q.quote_id || null }; }
  function importance(ratio, extra) {
    /* a ranking aid only: how far past its own threshold the finding is,
       capped, with its parts returned (an engineering judgment, not a
       validated measure of anything) */
    var mag = isNum(ratio) ? Math.min(3, Math.max(0, ratio)) : 0;
    var parts = { magnitude_vs_threshold: r3(ratio), magnitude_points: Math.round(mag / 3 * 70) };
    var score = parts.magnitude_points;
    Object.keys(extra || {}).forEach(function (k) { parts[k] = extra[k]; score += extra[k]; });
    return { score: Math.max(0, Math.min(100, Math.round(score))), parts: parts, basis: 'ranking aid: magnitude past the eligibility threshold, capped; not a probability or a value' };
  }

  function analyze(x) {
    x = x || {};
    var game = x.game || {}, now = ms(x.now), start = ms(game.kickoff);
    var model = x.model || null, cx = x.context || {};
    var ctx = { sport: x.sport || null, event_key: game.event_key || (x.sport ? String(x.sport).toUpperCase() + '|' + game.game_id : String(game.game_id)), now: now, start: start, model: model };
    var S = series(x.quotes, { game_id: game.game_id, season: game.season, kickoff: game.kickoff, home: game.home, away: game.away }, now);
    var findings = [], notEligible = [];
    function ne(type, why, market) { notEligible.push({ type: type, market: market || null, why: why }); }
    var started = start != null && now != null && now >= start;
    var hist = cx.historical || {};                /* market/type -> sentence from validation.json */
    var histNote = function (k) { return hist[k] || 'No validated history for this kind of finding yet (docs/market-intelligence/VALIDATION.md).'; };
    var mv = model ? (model.model_version || 'EdgeDesk model') : null;
    var published = model ? ms(model.predicted_at) : null;

    /* rule conflict first: a market whose settlement differs is never compared */
    var conflict = {};
    RULES.markets.forEach(function (m) {
      var a = model && model.settles ? model.settles[m] : null, b = x.market_settles ? x.market_settles[m] : null;
      if (a && b && String(a) !== String(b)) {
        conflict[m] = true;
        findings.push(finding('RULE_DEFINITION_CONFLICT', ctx, { market: m,
          eligibility: { rule: 'model and market settlement codes both known and different', met: true, values: { model: a, market: b } },
          evidence: { model_settles: a, market_settles: b }, key: [a, b],
          importance: importance(1, {}), tier: 'T0_OBSERVED',
          explain: {
            what_changed: 'Nothing moved. The two numbers measure different outcomes.',
            what_we_observed: 'The model\'s ' + m + ' number settles as ' + a + '; the market\'s settles as ' + b + '.',
            what_the_model_says: mv + ' states its ' + m + ' number under ' + a + '.',
            what_the_market_says: 'The market\'s ' + m + ' settles under ' + b + '.',
            what_we_can_verify: 'Both settlement definitions as recorded with the numbers.',
            what_remains_uncertain: 'How much of any difference between the two numbers is the definition rather than a disagreement about the game.',
            what_historical_data_suggests: 'Not applicable: a definition difference is a fact, not a forecast.'
          } }));
      } else if (!(a && b)) ne('RULE_DEFINITION_CONFLICT', 'settlement of the model or the market is not recorded for ' + m, m);
    });

    /* data completeness and freshness */
    var anyQuote = S.accepted.length > 0;
    var missing = [];
    RULES.markets.forEach(function (m) { if (!S.by[m]) missing.push(m + ': no valid pregame quote'); });
    if (S.by.spread) Object.keys(S.by.spread).forEach(function (b) { var q = S.by.spread[b][S.by.spread[b].length - 1]; if (q.price_home == null || q.price_away == null) missing.push('spread at ' + q.book + ': one side has no price'); });
    if (S.by.total) Object.keys(S.by.total).forEach(function (b) { var q = S.by.total[b][S.by.total[b].length - 1]; if (q.price_over == null || q.price_under == null) missing.push('total at ' + q.book + ': one side has no price'); });
    if (S.by.moneyline) Object.keys(S.by.moneyline).forEach(function (b) { var q = S.by.moneyline[b][S.by.moneyline[b].length - 1]; if (q.price_home == null || q.price_away == null) missing.push('moneyline at ' + q.book + ': one side has no price'); });
    S.rejected.forEach(function (rj) { missing.push((rj.quote.market_type || rj.quote.market_key || 'quote') + ' at ' + rj.quote.book + ' (' + stamp(rj.quote.observed_at) + ') failed: ' + rj.codes.join(', ')); });
    if (missing.length) {
      findings.push(finding('INCOMPLETE_MARKET_DATA', ctx, {
        eligibility: { rule: 'a market with no valid pregame quote, a one-sided price, or a quote that failed a check', met: true, values: { items: missing.length } },
        evidence: { missing: missing, accepted_quotes: S.accepted.length, rejected_quotes: S.rejected.length }, key: missing,
        importance: importance(missing.length / 3, {}), tier: 'T0_OBSERVED',
        explain: {
          what_changed: anyQuote ? 'Part of the market is missing or failed a check.' : 'No valid pregame market was captured for this game.',
          what_we_observed: missing.slice(0, 6).join('; ') + (missing.length > 6 ? '; and ' + (missing.length - 6) + ' more.' : '.'),
          what_the_model_says: model ? 'EdgeDesk\'s own number is unaffected: it never reads the market.' : 'No EdgeDesk number for this game.',
          what_the_market_says: anyQuote ? 'Only the markets listed as present can be compared.' : 'Nothing.',
          what_we_can_verify: 'Which quotes were captured, when, and which check each failed.',
          what_remains_uncertain: 'Whether the market exists at the book and was not captured, or does not exist.',
          what_historical_data_suggests: 'Not applicable: completeness is a property of the capture.'
        } }));
    }
    if (anyQuote && !started) {
      var newest = Math.max.apply(null, S.accepted.map(function (q) { return ms(q.observed_at); }));
      var age = now != null ? (now - newest) / 60000 : null;
      if (age != null && age > RULES.stale_minutes) {
        findings.push(finding('STALE_MARKET_DATA', ctx, {
          eligibility: { rule: 'newest valid pregame quote older than ' + RULES.stale_minutes + ' minutes', met: true, values: { age_minutes: Math.round(age) } },
          evidence: { newest_observed_at: iso(newest), age_minutes: Math.round(age), limit_minutes: RULES.stale_minutes }, key: [iso(newest)],
          importance: importance(age / RULES.stale_minutes, {}), tier: 'T0_OBSERVED',
          explain: {
            what_changed: 'No new quote has been captured for ' + Math.round(age) + ' minutes.',
            what_we_observed: 'The newest valid pregame quote was observed at ' + stamp(newest) + '.',
            what_the_model_says: model ? 'EdgeDesk\'s number does not depend on the market.' : 'No EdgeDesk number for this game.',
            what_the_market_says: 'The last captured numbers are shown as captured, not as current prices.',
            what_we_can_verify: 'The capture time of every quote.',
            what_remains_uncertain: 'What the market is now.',
            what_historical_data_suggests: 'Not applicable: freshness is a property of the capture.'
          } }));
      }
    } else if (!anyQuote) ne('STALE_MARKET_DATA', 'no valid pregame quote to age');

    /* convergence / divergence, per market and per sportsbook */
    RULES.markets.forEach(function (m) {
      var mvv = modelValue(model, m);
      if (conflict[m]) return ne('MARKET_CONVERGENCE', 'settlement definitions differ', m);
      if (mvv == null || published == null) return ne('MARKET_CONVERGENCE', 'no EdgeDesk ' + m + ' number with a publication time', m);
      if (!S.by[m]) return ne('MARKET_CONVERGENCE', 'no valid pregame ' + m + ' quote', m);
      Object.keys(S.by[m]).forEach(function (b) {
        var list = S.by[m][b];
        var q0 = latestAtOrBefore(list, published) || list.filter(function (q) { return ms(q.observed_at) >= published; })[0];
        var q1 = list[list.length - 1];
        if (!q0 || !q1 || q0 === q1) return ne('MARKET_CONVERGENCE', b + ': one ' + m + ' quote only', m);
        var hrs = (ms(q1.observed_at) - ms(q0.observed_at)) / 3600000;
        if (hrs < RULES.movement_min_hours) return ne('MARKET_CONVERGENCE', b + ': quotes ' + r1(hrs) + ' h apart (needs ' + RULES.movement_min_hours + ' h)', m);
        var v0 = valueOf(q0, m), v1 = valueOf(q1, m);
        if (v0 == null || v1 == null) return ne('MARKET_CONVERGENCE', b + ': a ' + m + ' quote carries no usable number', m);
        var g0 = mvv - v0, g1 = mvv - v1, d = Math.abs(g1) - Math.abs(g0), thr = RULES.move_threshold[m];
        if (Math.abs(d) < thr) return;
        var type = d < 0 ? 'MARKET_CONVERGENCE' : 'MARKET_DIVERGENCE';
        var crossed = g0 !== 0 && g1 !== 0 && (g0 > 0) !== (g1 > 0);
        var unit = m === 'moneyline' ? ' percentage points' : ' points';
        var amt = m === 'moneyline' ? r1(100 * Math.abs(d)) : r1(Math.abs(d));
        findings.push(finding(type, ctx, { market: m,
          eligibility: { rule: 'the gap between EdgeDesk\'s number and one source\'s ' + m + ' changed by at least ' + thr + (m === 'moneyline' ? ' (probability)' : ' points') + ' over at least ' + RULES.movement_min_hours + ' h, both quotes pregame', met: true,
            values: { gap_at_publication: r3(g0), gap_now: r3(g1), change: r3(d), hours: r1(hrs) } },
          evidence: { market_then: r3(v0), market_now: r3(v1), model: r3(mvv), gap_then: r3(g0), gap_now: r3(g1), crossed_model: crossed, hours: r1(hrs), book: q1.book, source: q1.source },
          key: [b, iso(q0.observed_at), iso(q1.observed_at), r3(v0), r3(v1)],
          sources: [sourceRef(q0), sourceRef(q1)], importance: importance(Math.abs(d) / thr, {}),
          explain: {
            what_changed: srcName(q1) + ' moved from ' + fmtValue(v0, m) + ' to ' + fmtValue(v1, m) + ' between ' + stamp(q0.observed_at) + ' and ' + stamp(q1.observed_at) + ': ' + amt + unit + (d < 0 ? ' closer to' : ' further from') + ' EdgeDesk\'s number' + (crossed ? ', crossing it' : '') + '.',
            what_we_observed: 'Two pregame ' + m + ' quotes from ' + srcName(q1) + ', ' + r1(hrs) + ' h apart.',
            what_the_model_says: mv + ' (published ' + stamp(published) + '): ' + fmtModel(mvv, m) + '.',
            what_the_market_says: srcName(q1) + ' at ' + stamp(q1.observed_at) + ': ' + fmtValue(v1, m) + '.',
            what_we_can_verify: 'Both quotes, their source and their capture times; EdgeDesk\'s number and its publication time.',
            what_remains_uncertain: 'Why the market moved. A public price moving is not evidence of who bet or why, and one source is not the whole market.',
            what_historical_data_suggests: histNote(m + ':movement_toward_model')
          } }));
      });
    });

    /* unusual movement: against earlier games' moves only */
    RULES.markets.forEach(function (m) {
      if (!S.by[m]) return ne('UNUSUAL_PRICE_MOVEMENT', 'no valid pregame ' + m + ' quote', m);
      var hm = (cx.movement_history || {})[m] || [];
      if (hm.length < RULES.unusual_min_history) return ne('UNUSUAL_PRICE_MOVEMENT', 'history of ' + hm.length + ' earlier ' + m + ' moves (needs ' + RULES.unusual_min_history + ')', m);
      var sorted = hm.slice().sort(function (a, b) { return a - b; }), cut = quantile(sorted, RULES.unusual_percentile);
      Object.keys(S.by[m]).forEach(function (b) {
        var list = S.by[m][b], q0 = list[0], q1 = list[list.length - 1];
        if (q0 === q1) return;
        var v0 = valueOf(q0, m), v1 = valueOf(q1, m);
        if (v0 == null || v1 == null) return;
        var mov = Math.abs(v1 - v0);
        if (!(mov > cut) || !(mov > 0)) return;
        var rank = sorted.filter(function (v) { return v < mov; }).length / sorted.length;
        findings.push(finding('UNUSUAL_PRICE_MOVEMENT', ctx, { market: m,
          eligibility: { rule: 'move from the first to the latest pregame quote above the ' + Math.round(100 * RULES.unusual_percentile) + 'th percentile of ' + hm.length + ' earlier games\' moves', met: true,
            values: { move: r3(mov), percentile_cut: r3(cut), history_n: hm.length } },
          evidence: { first: r3(v0), latest: r3(v1), move: r3(mov), percentile_cut: r3(cut), share_of_earlier_moves_below: r3(rank), history_n: hm.length, book: q1.book, source: q1.source },
          key: [b, iso(q0.observed_at), iso(q1.observed_at), r3(v0), r3(v1)],
          sources: [sourceRef(q0), sourceRef(q1)], importance: importance(mov / (cut || 1), {}),
          explain: {
            what_changed: srcName(q1) + ' moved from ' + fmtValue(v0, m) + ' (' + stamp(q0.observed_at) + ') to ' + fmtValue(v1, m) + ' (' + stamp(q1.observed_at) + ').',
            what_we_observed: 'A move of ' + (m === 'moneyline' ? r1(100 * mov) + ' percentage points' : r1(mov) + ' points') + ', larger than ' + Math.round(100 * rank) + '% of ' + hm.length + ' earlier games\' moves in this sport.',
            what_the_model_says: model && modelValue(model, m) != null && !conflict[m] ? mv + ': ' + fmtModel(modelValue(model, m), m) + '.' : 'No comparable EdgeDesk number.',
            what_the_market_says: srcName(q1) + ' at ' + stamp(q1.observed_at) + ': ' + fmtValue(v1, m) + '.',
            what_we_can_verify: 'Both quotes and their capture times, and the earlier games the move is ranked against.',
            what_remains_uncertain: 'What caused it. News, an injury report, a correction, or a book adjusting its own exposure all look the same in a public price.',
            what_historical_data_suggests: histNote(m + ':unusual_movement')
          } }));
      });
    });

    /* two independent sources on different numbers */
    RULES.markets.forEach(function (m) {
      var books = S.by[m] ? Object.keys(S.by[m]) : [];
      if (books.length < 2) return ne('SOURCE_DISAGREEMENT', books.length ? 'one source only (' + books[0] + ')' : 'no valid pregame ' + m + ' quote', m);
      var latest = books.map(function (b) { return S.by[m][b][S.by[m][b].length - 1]; });
      var tmax = Math.max.apply(null, latest.map(function (q) { return ms(q.observed_at); }));
      var near = latest.filter(function (q) { return tmax - ms(q.observed_at) <= RULES.disagreement_window_minutes * 60000; });
      if (near.length < 2) return ne('SOURCE_DISAGREEMENT', 'the sources\' latest quotes are more than ' + RULES.disagreement_window_minutes + ' minutes apart', m);
      var vals = near.map(function (q) { return { q: q, v: valueOf(q, m) }; }).filter(function (o) { return o.v != null; }).sort(function (a, b) { return a.v - b.v; });
      if (vals.length < 2) return;
      var lo = vals[0], hi = vals[vals.length - 1], spread = hi.v - lo.v, thr = RULES.disagreement_threshold[m];
      if (spread < thr) return;
      findings.push(finding('SOURCE_DISAGREEMENT', ctx, { market: m,
        eligibility: { rule: 'two sportsbooks\' latest ' + m + ' quotes, within ' + RULES.disagreement_window_minutes + ' minutes, at least ' + thr + (m === 'moneyline' ? ' apart in probability' : ' points apart'), met: true, values: { difference: r3(spread), books: vals.length } },
        evidence: { low: { book: lo.q.book, value: r3(lo.v) }, high: { book: hi.q.book, value: r3(hi.v) }, difference: r3(spread), books: vals.length },
        key: [iso(lo.q.observed_at), iso(hi.q.observed_at), r3(lo.v), r3(hi.v)],
        sources: vals.map(function (o) { return sourceRef(o.q); }), importance: importance(spread / thr, { books: Math.min(30, 10 * (vals.length - 1)) }),
        explain: {
          what_changed: srcName(lo.q) + ' and ' + srcName(hi.q) + ' are on different numbers.',
          what_we_observed: srcName(lo.q) + ' ' + fmtValue(lo.v, m) + ' (' + stamp(lo.q.observed_at) + '); ' + srcName(hi.q) + ' ' + fmtValue(hi.v, m) + ' (' + stamp(hi.q.observed_at) + ').',
          what_the_model_says: model && modelValue(model, m) != null && !conflict[m] ? mv + ': ' + fmtModel(modelValue(model, m), m) + '.' : 'No comparable EdgeDesk number.',
          what_the_market_says: vals.length + ' sources, ' + (m === 'moneyline' ? r1(100 * spread) + ' percentage points' : r1(spread) + ' points') + ' apart.',
          what_we_can_verify: 'Each source\'s quote and capture time.',
          what_remains_uncertain: 'Whether either price could be taken in size, and whether one source is simply slower to update.',
          what_historical_data_suggests: histNote(m + ':source_disagreement')
        } }));
    });

    /* one book's moneyline against its own spread */
    var fit = cx.derivative_fit || null;
    if (!fit || !(fit.n >= RULES.derivative_min_fit) || !isNum(fit.b) || !isNum(fit.sd) || !(fit.sd > 0)) ne('DERIVATIVE_RELATIONSHIP_ANOMALY', 'the spread–moneyline relationship was fitted on ' + (fit ? fit.n : 0) + ' earlier pairs (needs ' + RULES.derivative_min_fit + ')');
    else {
      var pairs = derivativePairs(S.accepted);
      if (!pairs.length) ne('DERIVATIVE_RELATIONSHIP_ANOMALY', 'no capture carries both a spread and a two-sided moneyline from one book');
      var lastBy = {};
      pairs.forEach(function (p) { if (!lastBy[p.book] || p.observed_at > lastBy[p.book].observed_at) lastBy[p.book] = p; });
      Object.keys(lastBy).forEach(function (b) {
        var p = lastBy[b], pred = fit.a + fit.b * p.margin, z = (p.y - pred) / fit.sd;
        if (Math.abs(z) < RULES.derivative_z) return;
        var pm = sigm(p.y), ps = sigm(pred);
        findings.push(finding('DERIVATIVE_RELATIONSHIP_ANOMALY', ctx, { market: 'moneyline',
          eligibility: { rule: 'the moneyline\'s no-vig probability is ' + RULES.derivative_z + '+ residual sd from what the same book\'s spread implies (fitted on ' + fit.n + ' earlier pairs)', met: true, values: { z: r3(z) } },
          evidence: { book: b, observed_at: p.observed_at, spread_home_margin: r3(p.margin), moneyline_p_home: r3(pm), spread_implied_p_home: r3(ps), z: r3(z), fit_n: fit.n },
          key: [b, p.observed_at, r3(p.margin), r3(pm)],
          sources: [{ book: b, source: null, observed_at: p.observed_at, quote_id: null }], importance: importance(Math.abs(z) / RULES.derivative_z, {}),
          explain: {
            what_changed: 'In one capture at ' + stamp(p.observed_at) + ', ' + b + '\'s moneyline and its spread imply different home win probabilities.',
            what_we_observed: 'Moneyline (no-vig) home ' + pct(pm) + '; the same book\'s spread (' + line(-p.margin) + ') implies about ' + pct(ps) + ' on its usual relationship.',
            what_the_model_says: model && isNum(num(model.p_home)) && !conflict.moneyline ? mv + ': home win ' + pct(num(model.p_home)) + '.' : 'No comparable EdgeDesk probability.',
            what_the_market_says: 'The book\'s two markets disagree with each other by ' + r1(Math.abs(z)) + ' residual standard deviations.',
            what_we_can_verify: 'Both prices, from one book, in one capture.',
            what_remains_uncertain: 'Which of the two is current: a feed that republishes one market later than the other produces exactly this.',
            what_historical_data_suggests: histNote('moneyline:derivative_anomaly')
          } }));
      });
    }

    /* the model's own validated biases, for games in an affected slice */
    var applicable = (cx.reliability || []).filter(function (w) { return w && w.applies; });
    if (!(cx.reliability || []).length) ne('MODEL_CALIBRATION_WARNING', 'no validation result supplied for this sport');
    applicable.forEach(function (w) {
      findings.push(finding('MODEL_CALIBRATION_WARNING', ctx, { market: w.market || null,
        eligibility: { rule: 'a validation result for a slice this game belongs to: an ACCEPTED bias hypothesis, or a calibration verdict other than consistent', met: true, values: { source: w.id, n: w.n } },
        evidence: { id: w.id, slice: w.slice, estimate: w.est, ci: w.ci, n: w.n, status: w.status }, key: [w.id, w.slice],
        importance: importance(1, {}), tier: 'T2_COMPUTED',
        explain: {
          what_changed: 'Nothing about this game: the warning is about the model.',
          what_we_observed: w.text,
          what_the_model_says: model ? mv + ': ' + (model.home_margin != null ? fmtModel(num(model.home_margin), 'spread') : fmtModel(num(model.p_home), 'moneyline')) + '.' : 'No EdgeDesk number for this game.',
          what_the_market_says: 'Read the market beside the model\'s known bias in this slice, not instead of it.',
          what_we_can_verify: 'The validation result, its sample size and its interval (' + (w.source || 'docs/market-intelligence/validation.json') + ').',
          what_remains_uncertain: 'Whether the bias holds in this particular game; a slice-level bias is an average.',
          what_historical_data_suggests: w.text
        } }));
    });

    findings.sort(function (a, b) { return (b.importance ? b.importance.score : 0) - (a.importance ? a.importance.score : 0) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0); });
    var sources = {};
    S.accepted.forEach(function (q) { sources[bookKey(q.book)] = 1; });
    return {
      version: VERSION, event_key: ctx.event_key, sport: ctx.sport, as_of: iso(now), start: iso(start), started: started,
      findings: findings, not_eligible: notEligible,
      quality: { accepted_quotes: S.accepted.length, rejected_quotes: S.rejected.length, sources: Object.keys(sources).sort(),
        single_source: Object.keys(sources).length === 1, note: Object.keys(sources).length === 1 ? 'one sportsbook only: source disagreement cannot be evaluated' : null },
      rules: RULES
    };
  }

  return {
    VERSION: VERSION, TYPES: TYPES, TYPE_KEYS: TYPE_KEYS, RULES: RULES, NO_MYTH: NO_MYTH,
    analyze: analyze, series: series, valueOf: valueOf, bookKey: bookKey,
    derivativePairs: derivativePairs, fitDerivative: fitDerivative, quantile: quantile
  };
}));

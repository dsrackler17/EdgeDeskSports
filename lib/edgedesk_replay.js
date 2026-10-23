/* ===========================================================================
   EDGEDESK REPLAY — what EdgeDesk and the market knew about one game at one
   moment, and nothing after it. docs/market-intelligence/MASTER_PLAN.md §7

   stateAt(data, eventKey, at) rebuilds the research state at `at` from the
   committed point-in-time records the caller supplies:

     forecasts   performance-ledger forecasts (hash-chained), football-record
                 first/last pregame numbers, each with its publication time
     quotes      captured quotes, each with the time EdgeDesk OBSERVED it
     results     verified finals

   and returns: the latest forecast published at or before `at` (and every
   earlier one, as revisions), the market as captured at or before `at`, the
   market-intelligence findings as they would have read then
   (lib/edgedesk_market_intel.js run with now = at), a timeline of everything
   up to `at`, and the result — WITHHELD unless the caller asks to reveal it
   and the game had finished by `at`, and even then kept in its own block.

   THE TIME RULES
     - a record stamped after `at` is never read, whatever it says;
     - observed_at is when EdgeDesk captured a quote, never when the book
       posted it: the timeline says "captured", never "posted";
     - a game with no record before `at` is reported as NO_HISTORY, not
       reconstructed from later data;
     - each source's coverage window is returned, so a replay of a moment
       before a ledger began says so instead of looking empty by accident.

   Browser: window.EDReplay (load edgedesk_market_state.js, edgedesk_calc.js
   and edgedesk_market_intel.js first). Node: require('./edgedesk_replay.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDReplay = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_replay_v1';
  var MI = null;
  if (typeof require === 'function' && typeof module === 'object' && module.exports) { try { MI = require('./edgedesk_market_intel.js'); } catch (e) { MI = null; } }
  function mi() { var m = MI || (root && root.EDMarketIntel); if (!m) throw new Error('EDReplay needs lib/edgedesk_market_intel.js'); return m; }

  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* the coverage window of each source: first and last stamp it holds */
  function coverage(data) {
    var out = {};
    function span(name, list, field) {
      var ts = (list || []).map(function (x) { return ms(field(x)); }).filter(function (t) { return t != null; });
      out[name] = ts.length ? { from: iso(Math.min.apply(null, ts)), to: iso(Math.max.apply(null, ts)), records: ts.length } : { from: null, to: null, records: 0 };
    }
    span('forecasts', data.forecasts, function (f) { return f.published_at; });
    span('quotes', data.quotes, function (q) { return q.observed_at; });
    span('results', data.results, function (r) { return r.verified_at || r.final_at; });
    return out;
  }

  function stateAt(data, eventKey, at, opts) {
    opts = opts || {};
    data = data || {};
    var t = ms(at);
    if (t == null) return { version: VERSION, event_key: eventKey, at: null, state: 'NO_TIME', why: 'no replay time' };
    var game = (data.games || []).filter(function (g) { return g.event_key === eventKey; })[0] || null;
    var cov = coverage(data);
    var fc = (data.forecasts || []).filter(function (f) { return f.event_key === eventKey; });
    var qs = (data.quotes || []).filter(function (q) { return q.event_key === eventKey; });
    var knownF = fc.filter(function (f) { var p = ms(f.published_at); return p != null && p <= t; }).sort(function (a, b) { return ms(a.published_at) - ms(b.published_at); });
    var knownQ = qs.filter(function (q) { var o = ms(q.observed_at); return o != null && o <= t; });
    var hiddenLater = { forecasts: fc.length - knownF.length, quotes: qs.length - knownQ.length };
    var start = game ? ms(game.kickoff) : null;
    var base = { version: VERSION, event_key: eventKey, at: iso(t), game: game, coverage: cov, withheld_after_at: hiddenLater,
      rule: 'every record is read only if it was published or captured at or before ' + iso(t) + '; captured times are when EdgeDesk saw a price, not when a book posted it' };
    if (!game) return Object.assign(base, { state: 'UNKNOWN_EVENT', why: 'no game ' + eventKey + ' in the supplied data' });
    if (!knownF.length && !knownQ.length) {
      var before = ['forecasts', 'quotes'].filter(function (k) { return cov[k].from && ms(cov[k].from) > t; });
      return Object.assign(base, { state: 'NO_HISTORY', why: before.length ? 'the ' + before.join(' and ') + ' ledger' + (before.length > 1 ? 's begin' : ' begins') + ' after this moment' : 'nothing about this game was recorded by this moment' });
    }
    var latest = knownF.length ? knownF[knownF.length - 1] : null;
    var model = latest ? { home_margin: latest.home_margin, fair_total: latest.fair_total, p_home: latest.p_home, model_version: latest.model_version, predicted_at: latest.published_at, settles: latest.settles || null } : null;
    var intel = mi().analyze({ sport: game.sport, now: iso(t), game: { event_key: eventKey, game_id: game.game_id, season: game.season, kickoff: game.kickoff, home: game.home, away: game.away },
      quotes: knownQ, model: model, market_settles: opts.market_settles || null, context: opts.context || {} });
    var timeline = [];
    knownF.forEach(function (f) { timeline.push({ at: iso(f.published_at), kind: 'FORECAST_PUBLISHED', what: (f.model_version || 'model') + (isNum(f.home_margin) ? ': home by ' + Math.round(f.home_margin * 10) / 10 : '') + (isNum(f.p_home) ? ', home win ' + (100 * f.p_home).toFixed(1) + '%' : ''), source: f.source || null, tier: f.tier || null }); });
    var lastVal = {};
    knownQ.slice().sort(function (a, b) { return ms(a.observed_at) - ms(b.observed_at); }).forEach(function (q) {
      var m = q.market_type, v = m === 'spread' ? q.home_line : m === 'total' ? (q.total_points != null ? q.total_points : q.total) : (q.price_home + '/' + q.price_away);
      var k = (q.book || '') + '|' + m;
      if (lastVal[k] === v) return;
      lastVal[k] = v;
      timeline.push({ at: iso(q.observed_at), kind: 'QUOTE_CAPTURED', what: (q.book || 'book') + ' ' + m + ' ' + v, source: q.source || null });
    });
    intel.findings.forEach(function (f) { timeline.push({ at: iso(t), kind: 'FINDING', what: f.label + (f.market ? ' (' + f.market + ')' : ''), finding_id: f.finding_id }); });
    if (start != null && start <= t) timeline.push({ at: iso(start), kind: 'KICKOFF', what: 'the game started' });
    timeline.sort(function (a, b) { return ms(a.at) - ms(b.at); });
    var res = (data.results || []).filter(function (r) { return r.event_key === eventKey; })[0] || null;
    var knownAt = res ? ms(res.verified_at || res.final_at) : null;
    var result = { state: 'WITHHELD', why: 'the result is revealed only on request, and only for a game already finished at the replay time' };
    if (opts.reveal) {
      if (!res) result = { state: 'NOT_AVAILABLE', why: 'no verified final in the supplied data' };
      else if (knownAt == null || knownAt > t) result = { state: 'NOT_YET_KNOWN', why: 'the final was verified at ' + (iso(knownAt) || 'an unknown time') + ', after this moment' };
      else result = { state: 'REVEALED', home_score: res.home_score, away_score: res.away_score, verified_at: iso(knownAt), source: res.source || null };
    }
    return Object.assign(base, {
      state: start != null && t >= start ? 'STARTED' : 'PREGAME',
      forecast: latest ? { model_version: latest.model_version, published_at: iso(latest.published_at), home_margin: latest.home_margin, fair_total: latest.fair_total, p_home: latest.p_home, source: latest.source || null, tier: latest.tier || null } : null,
      revisions: knownF.length,
      market: intel.quality, findings: intel.findings, not_eligible: intel.not_eligible,
      timeline: timeline, result: result
    });
  }

  return { VERSION: VERSION, stateAt: stateAt, coverage: coverage };
}));

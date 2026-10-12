/* ===========================================================================
   EdgeDesk ODDS RECOVERY PLANNER (EDODDSPLAN) — what a market-data schedule
   costs in The Odds API credits, and how much of the time it lets the research
   engine VERIFY a price (the MARKET readiness state).
   docs/research-engine/ODDS_RECOVERY.md

   A PLANNING TOOL ONLY. It calls nothing, buys nothing and enables nothing.
   Market capture stays paused until an operator follows the incident runbook
   (docs/odds-api-incident-2026-10/INCIDENT.md §9).

   THE RULES IT USES (sources in the doc)
     credits per request = markets × regions, where a bookmaker list counts one
       region per 10 books (the incident's "3 credits per sport request" for
       h2h, spreads and totals over a 10-book list).
     one request per sport returns every event of that sport, so a sport's
       cadence is set by its NEXT kickoff (the gateway's event-aware cadence).
     a price is VERIFIABLE at a moment when its age is within the readiness
       limit for that game's time to kickoff (EDINTEL quote_ttl_buckets:
       ≤0.5 h 5 min · ≤2 h 15 · ≤6 h 45 · ≤24 h 90 · ≤72 h 180 · beyond 360).

   Browser/Node: UMD, ES5. Pure arithmetic.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDODDSPLAN = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_odds_recovery_v1';
  /* supabase/functions/edgedesk_ai/_intelligence.js CONFIG.quote_ttl_buckets (the readiness limit by hours to kickoff) */
  var QUOTE_TTL = [[0.5, 5], [2, 15], [6, 45], [24, 90], [72, 180], [Infinity, 360]];
  /* supabase/capture_cron.sql / odds_gateway: the event-aware cadence planned for 1 November */
  var GATEWAY_CADENCE = [[3, 20], [24, 60], [72, 120], [Infinity, 360]];
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function band(list, hours) { for (var i = 0; i < list.length; i++) if (hours <= list[i][0]) return list[i][1]; return list[list.length - 1][1]; }

  /** markets × regions; a bookmaker list counts ceil(books / 10) regions. */
  function creditsPerRequest(o) {
    o = o || {};
    var markets = Math.max(1, num(o.markets) || 3);
    var regions = num(o.bookmakers) != null ? Math.max(1, Math.ceil(num(o.bookmakers) / 10)) : Math.max(1, num(o.regions) || 1);
    return markets * regions;
  }
  function ttlFor(hoursToStart) { return band(QUOTE_TTL, hoursToStart); }

  /**
   * Simulate a capture schedule minute by minute.
   * o: { sports: { key: [kickoff ISO...] }, from, to, cadence: [[max_hours, every_min]...], credits_per_request,
   *      refresh: { enabled, within_hours, min_gap_min, daily_credit_cap, demand_per_game } }   (refresh = research-triggered, see below)
   * → { requests, credits, by_sport, verifiable: { band: { minutes, ok, share } }, refresh: {...} }
   */
  function simulate(o) {
    o = o || {};
    var cad = o.cadence || GATEWAY_CADENCE, cpr = num(o.credits_per_request) || creditsPerRequest({});
    var from = toMs(o.from), to = toMs(o.to);
    var out = { schema: VERSION, from: new Date(from).toISOString(), to: new Date(to).toISOString(), credits_per_request: cpr, requests: 0, credits: 0, by_sport: {}, verifiable: {}, refresh: { requests: 0, credits: 0, capped_minutes: 0 } };
    var bands = ['≤0.5 h', '0.5–2 h', '2–6 h', '6–24 h', '24–72 h'];
    bands.forEach(function (b) { out.verifiable[b] = { minutes: 0, ok: 0, share: null }; });
    var bandOf = function (h) { return h <= 0.5 ? '≤0.5 h' : h <= 2 ? '0.5–2 h' : h <= 6 ? '2–6 h' : h <= 24 ? '6–24 h' : h <= 72 ? '24–72 h' : null; };
    var rf = o.refresh || null, dayCredits = {};
    Object.keys(o.sports || {}).forEach(function (sk) {
      var kicks = (o.sports[sk] || []).map(toMs).filter(function (t) { return t != null; }).sort(function (a, b) { return a - b; });
      var last = null, lastRefresh = null, req = 0, refreshReq = 0;
      for (var t = from; t < to; t += 60000) {
        var next = null; for (var i = 0; i < kicks.length; i++) if (kicks[i] > t) { next = kicks[i]; break; }
        if (next == null) continue;
        var h = (next - t) / 3600000, every = band(cad, h);
        if (last == null || (t - last) / 60000 >= every) { last = t; req++; }
        /* research-triggered refresh: a subscriber researching a game whose price is too old to verify, inside the window,
           buys one sport request — at most every min_gap_min per sport, inside a daily credit cap shared by everyone */
        if (rf && rf.enabled) {
          kicks.forEach(function (k) {
            var hk = (k - t) / 3600000; if (hk <= 0 || hk > (num(rf.within_hours) || 6)) return;
            var age = (t - last) / 60000;
            if (age <= ttlFor(hk)) return;
            var dk = new Date(t).toISOString().slice(0, 10);
            var demanded = (num(rf.demand_per_game) == null ? 1 : num(rf.demand_per_game)) > 0;
            if (!demanded) return;
            if (lastRefresh != null && (t - lastRefresh) / 60000 < (num(rf.min_gap_min) || 5)) return;
            if ((dayCredits[dk] || 0) + cpr > (num(rf.daily_credit_cap) || 120)) { out.refresh.capped_minutes++; return; }
            dayCredits[dk] = (dayCredits[dk] || 0) + cpr; last = t; lastRefresh = t; refreshReq++;
          });
        }
        kicks.forEach(function (k) {
          var hk = (k - t) / 3600000, b = bandOf(hk); if (!b || hk <= 0) return;
          out.verifiable[b].minutes++;
          if (last != null && (t - last) / 60000 <= ttlFor(hk)) out.verifiable[b].ok++;
        });
      }
      out.by_sport[sk] = { games: kicks.length, requests: req, refresh_requests: refreshReq, credits: (req + refreshReq) * cpr };
      out.requests += req; out.refresh.requests += refreshReq;
    });
    out.refresh.credits = out.refresh.requests * cpr;
    out.credits = (out.requests + out.refresh.requests) * cpr;
    bands.forEach(function (b) { var v = out.verifiable[b]; v.share = v.minutes ? Math.round(v.ok / v.minutes * 1000) / 1000 : null; });
    var days = (to - from) / 86400000;
    out.per_day = Math.round(out.credits / days * 10) / 10;
    out.per_30_days = Math.round(out.credits / days * 30);
    return out;
  }

  /** Fit a monthly projection against the incident's budget: operational ceiling, untouched reserve, what is already planned. */
  function fit(monthlyCredits, b) {
    b = b || {};
    var op = num(b.operational) || 60000, planned = num(b.planned) || 0, latch = num(b.breaker_latch) || 57000;
    var total = planned + monthlyCredits;
    return { monthly_credits: Math.round(monthlyCredits), planned: planned, total: Math.round(total), operational: op, breaker_latch: latch,
      headroom: Math.round(op - total), within: total <= latch, share_of_operational: Math.round(total / op * 1000) / 1000 };
  }

  return { VERSION: VERSION, QUOTE_TTL: QUOTE_TTL, GATEWAY_CADENCE: GATEWAY_CADENCE, creditsPerRequest: creditsPerRequest, ttlFor: ttlFor, simulate: simulate, fit: fit };
});

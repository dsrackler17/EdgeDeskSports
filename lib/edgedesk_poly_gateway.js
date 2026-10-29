/* ===========================================================================
   EdgeDesk PREDICTION RADAR — the Polymarket gateway. The ONLY Radar client
   of Polymarket's public APIs. docs/prediction-radar.md §Data sources

   The pattern of supabase/functions/odds_gateway (one door, a budget, a
   bounded backoff, fail closed), for a source that costs nothing but has
   rate limits and no stability guarantee:

     1 THE SWITCH. POLYMARKET_DATA_ENABLED must be on, or nothing is asked.
       The scheduled job reads it from public.radar_config at the start of
       every run (so it is turned off with one SQL statement, no deploy) and
       from the function's own environment; both must say on.
     2 THE BUDGET. Every attempt, retries included, takes one request from a
       budget the caller hands in. The scheduled job's budget is the grant of
       public.poly_api_acquire() (a daily ceiling and a per-run cap, decided
       under one row lock); the validation runner's is a fixed count.
       An empty budget is a refusal, never a wait.
     3 THE PACE. Requests to one host start at least pace_ms apart, whatever
       the concurrency.
     4 THE BACKOFF. No answer, a timeout, a 429 or a 5xx is retried at most
       max_retries times, base 1 s doubling, jittered +-20%, capped at 16 s; a
       429's Retry-After is honoured up to 60 s. Any other 4xx is not retried.
     5 THE BREAKER. breaker_after consecutive 429s or 5xx open it for the
       rest of the run: every later request is refused without being sent.
     6 THE ENDPOINTS. Only the paths in ENDPOINTS can be asked for. The P&L
       and rankings hosts are not here: they carry no stability guarantee, so
       Radar computes P&L itself from trades (lib/edgedesk_radar.js).
   tools/radar/no_bypass.test.js fails the build if any other Radar file
   names a Polymarket host.

   Node: require('./edgedesk_poly_gateway.js'). Deno (the edge function): a
   verbatim copy between BEGIN/END RADAR GATEWAY markers.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDPolyGateway = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var G = { VERSION: 'edgedesk_poly_gateway/1' };

  G.HOSTS = { data: 'https://data-api.polymarket.com', gamma: 'https://gamma-api.polymarket.com', clob: 'https://clob.polymarket.com' };
  G.ENDPOINTS = {
    leaderboard: { host: 'data', path: '/v1/leaderboard' },      /* the candidate pool (category SPORTS) */
    activity: { host: 'data', path: '/v2/activity' },            /* a wallet's trades, redemptions, splits, merges */
    positions: { host: 'data', path: '/v2/positions' },          /* a wallet's positions by status */
    holders: { host: 'data', path: '/v2/holders' },              /* who holds each side of one market */
    holders_v1: { host: 'data', path: '/holders' },              /* the documented v1 holders list (the probe compares the two) */
    sports: { host: 'gamma', path: '/sports' },                  /* the leagues and their series */
    events: { host: 'gamma', path: '/events' },                  /* game events and their markets */
    markets: { host: 'gamma', path: '/markets' },                /* market metadata, by condition id */
    prices_history: { host: 'clob', path: '/prices-history' }    /* one outcome token's price over time */
  };
  G.DEFAULTS = { pace_ms: { data: 120, gamma: 80, clob: 120 }, max_retries: 3, timeout_ms: 20000, backoff_base_ms: 1000, backoff_cap_ms: 16000,
    retry_after_cap_ms: 60000, breaker_after: 6, user_agent: 'EdgeDesk Prediction Radar (+https://edgedesksports.com/radar/)' };

  /* the URL for one endpoint: arrays repeat their key (condition_ids=a&condition_ids=b) */
  G.url = function (endpoint, params, bases) {
    var e = G.ENDPOINTS[endpoint];
    if (!e) throw new Error('poly gateway: unknown endpoint ' + endpoint + ' (only ' + Object.keys(G.ENDPOINTS).join(', ') + ')');
    var base = ((bases && bases[e.host]) || G.HOSTS[e.host]).replace(/\/$/, '');
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) { q.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(x))); });
    });
    return base + e.path + (q.length ? '?' + q.join('&') : '');
  };

  /* temporary failures: no answer, a timeout, a rate limit, the server's own 5xx */
  G.retryable = function (status, timedOut) { return !!timedOut || status === 0 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504; };
  /* backoff before retry n (1-based); a 429's Retry-After (seconds) wins when longer */
  G.backoffMs = function (n, retryAfterS, rnd, o) {
    o = o || G.DEFAULTS; rnd = rnd || Math.random;
    var raw = Math.min(o.backoff_cap_ms, o.backoff_base_ms * Math.pow(2, Math.max(0, n - 1)));
    var b = Math.round(Math.min(o.backoff_cap_ms, raw * (0.8 + 0.4 * rnd())));
    var ra = Number(retryAfterS);
    if (isFinite(ra) && ra > 0) b = Math.max(b, Math.min(o.retry_after_cap_ms, Math.round(ra * 1000)));
    return b;
  };

  /* a fixed budget (the validation runner): take() is true until it is spent */
  G.fixedBudget = function (limit) {
    var used = 0;
    return { limit: limit, take: function () { if (used >= limit) return false; used++; return true; }, get used() { return used; } };
  };

  /* opts: fetch, sleep, now, rnd, enabled (boolean or () => boolean), budget
     ({take()}), bases (tests), and any of DEFAULTS */
  G.make = function (opts) {
    opts = opts || {};
    var o = {};
    Object.keys(G.DEFAULTS).forEach(function (k) { o[k] = opts[k] != null ? opts[k] : G.DEFAULTS[k]; });
    if (opts.pace_ms) o.pace_ms = Object.assign({}, G.DEFAULTS.pace_ms, opts.pace_ms);
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var now = opts.now || function () { return Date.now(); };
    var rnd = opts.rnd || Math.random;
    var budget = opts.budget || null;
    var nextAt = {}, consecutive = 0, breaker = false;
    var stats = { requests: 0, ok: 0, retries: 0, refused: {}, statuses: {}, by_endpoint: {}, breaker: false, rate_limited: 0 };
    var refuse = function (decision, reason, url) { stats.refused[decision] = (stats.refused[decision] || 0) + 1; return { ok: false, status: 0, data: null, attempts: 0, decision: decision, reason: reason, url: url }; };
    var enabled = function () { return typeof opts.enabled === 'function' ? !!opts.enabled() : opts.enabled === true; };
    function deadline(ms) { try { return AbortSignal.timeout(ms); } catch (_) { return undefined; } }

    async function pace(host) {
      var t = now(), slot = Math.max(t, nextAt[host] || 0);
      nextAt[host] = slot + (o.pace_ms[host] || 0);
      if (slot > t) await sleep(slot - t);
    }

    async function get(endpoint, params) {
      var url = G.url(endpoint, params, opts.bases);
      if (!enabled()) return refuse('disabled', 'POLYMARKET_DATA_ENABLED is off: nothing was asked', url);
      if (!doFetch) return refuse('no_fetch', 'no fetch in this runtime', url);
      var host = G.ENDPOINTS[endpoint].host;
      stats.by_endpoint[endpoint] = (stats.by_endpoint[endpoint] || 0) + 1;
      for (var attempt = 1; ; attempt++) {
        if (breaker) return refuse('breaker_open', 'the breaker opened after ' + o.breaker_after + ' consecutive rate limits or server errors: nothing more this run', url);
        if (budget && !(await budget.take())) return refuse('budget_exhausted', 'the request budget for this run is spent', url);
        await pace(host);
        stats.requests++;
        var status = 0, text = '', timedOut = false, retryAfter = null;
        try {
          var r = await doFetch(url, { method: 'GET', headers: { accept: 'application/json', 'user-agent': o.user_agent }, signal: deadline(o.timeout_ms) });
          status = r.status;
          retryAfter = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
          text = String((await r.text()) || '');
        } catch (e) {
          var name = String((e && e.name) || '');
          timedOut = name === 'TimeoutError' || name === 'AbortError';
          text = (timedOut ? 'timeout after ' + o.timeout_ms + ' ms: ' : 'network: ') + String((e && e.message) || e).slice(0, 200);
        }
        stats.statuses[status] = (stats.statuses[status] || 0) + 1;
        if (status >= 200 && status < 300) {
          var data;
          try { data = text ? JSON.parse(text) : null; } catch (_) {
            consecutive = 0;
            return { ok: false, status: status, data: null, attempts: attempt, decision: 'malformed', reason: 'the answer was not JSON: ' + text.slice(0, 120), url: url };
          }
          consecutive = 0; stats.ok++;
          return { ok: true, status: status, data: data, attempts: attempt, decision: 'ok', reason: null, url: url };
        }
        if (status === 429) stats.rate_limited++;
        if (!G.retryable(status, timedOut)) {
          consecutive = 0;
          return { ok: false, status: status, data: null, attempts: attempt, decision: status ? 'http_' + status : 'unreachable', reason: text.slice(0, 240), url: url };
        }
        consecutive++;
        if (consecutive >= o.breaker_after) { breaker = true; stats.breaker = true; }
        if (attempt > o.max_retries || breaker) {
          return { ok: false, status: status, data: null, attempts: attempt, decision: breaker ? 'breaker_open' : (timedOut ? 'timeout' : status ? 'http_' + status : 'unreachable'), reason: text.slice(0, 240), url: url };
        }
        stats.retries++;
        await sleep(G.backoffMs(attempt, status === 429 ? retryAfter : null, rnd, o));
      }
    }
    return { get: get, stats: function () { return JSON.parse(JSON.stringify(stats)); }, options: o };
  };

  return G;
}));

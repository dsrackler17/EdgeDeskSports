'use strict';
/* ===========================================================================
   NCAAM-EARLY — the CollegeBasketballData.com (CBBD) client.

     const c = client({ key, fetch, base, maxCalls, reserve });
     await c.get('/games', { season: 2026, startDateRange, endDateRange })
       -> { ok, status, body, url, remaining } | { ok: false, refused | error }
     await c.windowed('/games', { season }, fromIso, toIso)
       -> { ok, rows, windows, split } (split until every window is under
          the endpoint's documented row cap)

   - Only the paths and query parameters in config/cbbd_endpoints.json (checked
     against the published OpenAPI document) can be asked for; anything else is
     refused before a call is made.
   - The key is a Bearer token from the job's environment (CBBD_API_KEY). It is
     never logged, never written and never in an error message (every message
     is redacted, every occurrence).
   - Budget: at most `maxCalls` calls per run, and no call once the provider's
     remaining count (X-CallLimit-Remaining, when sent) is below `reserve`.
     The quota is shared with CollegeFootballData, so the reserve protects
     the football jobs (config.js CBBD).
   - Retries: at most 2, only on a network error or a 5xx; never on a 4xx, a
     429 or a timeout. A 401/403 stops the run (the key is wrong or lacks the
     tier), and a 429 stops it (the quota is spent).
   Pure apart from the injected fetch: every test runs on a mocked one.
   =========================================================================== */
const fs = require('fs');
const C = require('./config');

let ENDPOINTS = null;
function endpoints() {
  if (!ENDPOINTS) ENDPOINTS = JSON.parse(fs.readFileSync(C.CBBD.endpoints_file, 'utf8'));
  return ENDPOINTS;
}

function check(path, params) {
  const e = endpoints().endpoints[path];
  if (!e) return 'the path ' + path + ' is not in the verified CBBD endpoint list (config/cbbd_endpoints.json)';
  for (const k of Object.keys(params || {})) if (!e.params.includes(k)) return 'the parameter ' + k + ' is not accepted by ' + path + ' (verified list: ' + e.params.join(', ') + ')';
  for (const k of e.required) if (params == null || params[k] == null || params[k] === '') return path + ' requires ' + k;
  return null;
}

function buildUrl(base, path, params) {
  const q = Object.keys(params || {}).filter((k) => params[k] != null && params[k] !== '').sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]))).join('&');
  return base.replace(/\/+$/, '') + path + (q ? '?' + q : '');
}

function client(o) {
  o = o || {};
  const key = String(o.key || '');
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const base = o.base || C.CBBD.base;
  const maxCalls = o.maxCalls == null ? C.CBBD.max_calls_per_run : o.maxCalls;
  const reserve = o.reserve == null ? C.CBBD.quota_reserve : o.reserve;
  const timeoutMs = o.timeoutMs || C.CBBD.timeout_ms;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const redact = (s) => (key ? String(s).split(key).join('[redacted]') : String(s));
  const state = { calls: 0, remaining: null, stopped: null, log: [] };

  async function get(path, params) {
    const bad = check(path, params);
    if (bad) return { ok: false, refused: bad };
    if (!key) return { ok: false, refused: 'no CBBD_API_KEY: the key is a repository secret and was not provided' };
    if (!doFetch) return { ok: false, refused: 'no fetch available' };
    if (state.stopped) return { ok: false, refused: 'the run stopped earlier: ' + state.stopped };
    if (state.calls >= maxCalls) return { ok: false, refused: 'the run\'s call cap (' + maxCalls + ') is reached' };
    if (state.remaining != null && state.remaining < reserve) {
      state.stopped = 'the provider reports ' + state.remaining + ' calls remaining, under the reserve of ' + reserve + ' kept for the football jobs (shared quota)';
      return { ok: false, refused: state.stopped };
    }
    const url = buildUrl(base, path, params);
    let last = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      state.calls++;
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
      let res;
      try {
        res = await doFetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: ac ? ac.signal : undefined });
      } catch (e) {
        if (timer) clearTimeout(timer);
        const timedOut = e && e.name === 'AbortError';
        last = { ok: false, url, error: 'the request to CBBD failed: ' + (timedOut ? 'timed out' : redact(e && e.message || e)) };
        state.log.push({ path, params, status: null, error: last.error });
        if (timedOut || attempt === 2 || state.calls >= maxCalls) return last;
        await sleep(1000 * Math.pow(2, attempt)); continue;
      }
      if (timer) clearTimeout(timer);
      const h = res.headers && typeof res.headers.get === 'function' ? res.headers : { get: () => null };
      const rem = h.get('x-calllimit-remaining');
      if (rem != null && Number.isFinite(Number(rem))) state.remaining = Number(rem);
      state.log.push({ path, params, status: res.status, remaining: state.remaining });
      if (res.ok) {
        let body;
        try { body = await res.json(); } catch (_) { return { ok: false, url, status: res.status, error: 'CBBD answered something that is not JSON' }; }
        return { ok: true, url, status: res.status, body, remaining: state.remaining };
      }
      if (res.status === 401 || res.status === 403) { state.stopped = 'CBBD answered HTTP ' + res.status + ' (the key is wrong or its tier lacks this endpoint)'; return { ok: false, url, status: res.status, error: state.stopped }; }
      if (res.status === 429) { state.stopped = 'CBBD answered HTTP 429 (the shared quota is spent or the rate limit was hit)'; return { ok: false, url, status: res.status, error: state.stopped }; }
      last = { ok: false, url, status: res.status, error: 'CBBD answered HTTP ' + res.status };
      if (res.status < 500 || attempt === 2 || state.calls >= maxCalls) return last;
      await sleep(1000 * Math.pow(2, attempt));
    }
    return last;
  }

  /* ask a capped, date-windowed endpoint for [from, to]; a window that comes
     back at the documented cap is split in two, so nothing is truncated */
  async function windowed(path, params, fromIso, toIso) {
    const cap = (endpoints().endpoints[path] || {}).row_cap;
    if (!cap) return { ok: false, refused: path + ' has no documented row cap: ask it whole' };
    const rows = []; const windows = []; let split = 0;
    const minMs = C.CBBD.min_window_days * 86400e3;
    async function one(a, b) {
      const r = await get(path, Object.assign({}, params, { startDateRange: new Date(a).toISOString(), endDateRange: new Date(b).toISOString() }));
      if (!r.ok) return r;
      if (!Array.isArray(r.body)) return { ok: false, error: path + ' answered something that is not a list' };
      if (r.body.length >= cap) {
        if (b - a <= minMs) return { ok: false, error: path + ' returned its cap (' + cap + ') for a window of ' + C.CBBD.min_window_days + ' day(s): it cannot be split further' };
        split++;
        const mid = a + Math.floor((b - a) / 2);
        const x = await one(a, mid); if (!x.ok) return x;
        return one(mid + 1, b);
      }
      windows.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), rows: r.body.length });
      for (const row of r.body) rows.push(row);
      return { ok: true };
    }
    const r = await one(Date.parse(fromIso), Date.parse(toIso));
    if (!r.ok) return r;
    return { ok: true, rows, windows, split };
  }

  return { get, windowed, state };
}

module.exports = { client, check, buildUrl, endpoints };

'use strict';
/* ===========================================================================
   EdgeDesk ENGINE — the guarded fetch every multi-sport ingest job uses.

   One client, one set of rules, per provider:

     CACHE        Every response body is written to disk under a key derived
                  from the URL. A request inside its `ttlMs` is served from the
                  cache and never reaches the network. A request outside it is
                  revalidated with If-None-Match / If-Modified-Since when the
                  provider sent an ETag or Last-Modified, so an unchanged file
                  costs a 304, not a download.
     STALE-IF-ERROR  When the network fails and a cached copy exists, the
                  cached copy is returned with `stale: true` and the failure is
                  reported. Nothing pretends a stale copy is fresh.
     DEDUPE       Two concurrent requests for the same URL share one fetch.
     QUOTA        Each provider has a per-run and a per-UTC-day request cap
                  (persisted in the cache directory). A request past either is
                  refused before it is sent. Paid providers default to a cap
                  of ZERO: a job must be configured to spend.
     BREAKER      After `breakerFailures` consecutive failures a provider's
                  breaker opens for `breakerCooldownMs`; requests are refused
                  (served stale when possible) until it half-opens.
     RETRIES      Network errors, 5xx and 429 are retried with exponential
                  backoff and jitter, honouring Retry-After. 4xx other than
                  429 is never retried. A paid provider is never retried here.
     CONCURRENCY  At most `concurrency` requests in flight per provider.

   Nothing in this file knows a sport. The odds provider is NOT reachable
   through it: The Odds API is only ever called by
   supabase/functions/odds_gateway (tools/odds/no_bypass.test.js).

   fetchImpl, now() and sleep() are injectable so the suite runs offline.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PROVIDERS = {
  /* public GitHub raw files (sportsdataverse, nflverse): free, keyless */
  github_raw: { host: /(^|\.)raw\.githubusercontent\.com$/, paid: false, perRun: 400, perDay: 4000, concurrency: 4, minIntervalMs: 0 },
  /* the NHL's own public web API: free, keyless, undocumented rate limit — be polite */
  nhl_api: { host: /(^|\.)api-web\.nhle\.com$|(^|\.)api\.nhle\.com$/, paid: false, perRun: 300, perDay: 3000, concurrency: 2, minIntervalMs: 250 },
};

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

class GuardError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
}

/**
 * createClient({ cacheDir, providers, fetchImpl, now, sleep, retries, breakerFailures, breakerCooldownMs, log })
 * → { get(url, opts) → { ok, status, body(Buffer), text(), json(), fromCache, stale, revalidated, provider, fetchedAt, error },
 *     (opts: ttlMs, noCache — never read the cache, noStore — never write it: a page parsed and thrown away)
 *     stats(), providerFor(url) }
 */
function createClient(o) {
  o = o || {};
  const cacheDir = o.cacheDir || path.join(process.cwd(), '.cache', 'engine_http');
  const providers = Object.assign({}, DEFAULT_PROVIDERS, o.providers || {});
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const now = o.now || (() => Date.now());
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = o.retries == null ? 3 : o.retries;
  const breakerFailures = o.breakerFailures || 4;
  const breakerCooldownMs = o.breakerCooldownMs || 15 * 60 * 1000;
  const timeoutMs = o.timeoutMs || 60000;
  const log = o.log || (() => {});
  const inflight = new Map();
  const active = {};
  const queue = {};
  const lastStart = {};
  const stats = { requests: 0, network: 0, cache_hits: 0, revalidated_304: 0, stale_served: 0, refused: 0, retries: 0, failures: 0, by_provider: {} };

  fs.mkdirSync(cacheDir, { recursive: true });
  const statePath = path.join(cacheDir, '_guard_state.json');
  function loadState() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return { day: {}, breaker: {} }; } }
  function saveState(s) { try { fs.writeFileSync(statePath, JSON.stringify(s)); } catch (_) { /* a read-only cache is not fatal */ } }
  const state = loadState();
  state.day = state.day || {}; state.breaker = state.breaker || {};
  const runCount = {};

  function providerFor(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { return null; }
    for (const name of Object.keys(providers)) if (providers[name].host && providers[name].host.test(host)) return name;
    return null;
  }
  function pstat(p) { return stats.by_provider[p] || (stats.by_provider[p] = { requests: 0, network: 0, cache_hits: 0, refused: 0, failures: 0 }); }
  function cachePaths(url) { const k = sha(url).slice(0, 40); return { body: path.join(cacheDir, k + '.body'), meta: path.join(cacheDir, k + '.json') }; }
  function readCache(url) {
    const c = cachePaths(url);
    try { const meta = JSON.parse(fs.readFileSync(c.meta, 'utf8')); const body = fs.readFileSync(c.body); return { meta, body }; } catch (_) { return null; }
  }
  function writeCache(url, body, meta) {
    const c = cachePaths(url);
    const tmp = c.body + '.tmp' + process.pid;
    fs.writeFileSync(tmp, body); fs.renameSync(tmp, c.body);
    fs.writeFileSync(c.meta, JSON.stringify(meta));
  }
  function result(base, body) {
    return Object.assign(base, {
      body,
      text: () => (body ? body.toString('utf8') : ''),
      json: () => JSON.parse(body ? body.toString('utf8') : 'null'),
    });
  }

  function quotaCheck(p, cfg) {
    const d = dayKey(now());
    const dk = p + '|' + d;
    const used = state.day[dk] || 0;
    const run = runCount[p] || 0;
    const perRun = cfg.paid && cfg.perRun == null ? 0 : cfg.perRun;
    const perDay = cfg.paid && cfg.perDay == null ? 0 : cfg.perDay;
    if (perRun != null && run >= perRun) return 'per-run quota of ' + perRun + ' requests reached for ' + p;
    if (perDay != null && used >= perDay) return 'per-day quota of ' + perDay + ' requests reached for ' + p + ' (' + d + ')';
    return null;
  }
  function quotaSpend(p) {
    const dk = p + '|' + dayKey(now());
    state.day[dk] = (state.day[dk] || 0) + 1;
    runCount[p] = (runCount[p] || 0) + 1;
    /* keep a week of day counters */
    const keep = new Set(); for (let i = 0; i < 7; i++) keep.add(dayKey(now() - i * 864e5));
    for (const k of Object.keys(state.day)) if (!keep.has(k.split('|')[1])) delete state.day[k];
    saveState(state);
  }
  function breakerOpen(p) {
    const b = state.breaker[p];
    if (!b || !b.open_until) return false;
    if (now() >= b.open_until) { b.open_until = null; b.half_open = true; saveState(state); return false; }
    return true;
  }
  function breakerRecord(p, ok) {
    const b = state.breaker[p] || (state.breaker[p] = { consecutive: 0, open_until: null });
    if (ok) { b.consecutive = 0; b.half_open = false; b.open_until = null; }
    else {
      b.consecutive = (b.consecutive || 0) + 1;
      if (b.half_open || b.consecutive >= breakerFailures) { b.open_until = now() + breakerCooldownMs; b.half_open = false; log('[guard] breaker OPEN for ' + p + ' until ' + new Date(b.open_until).toISOString()); }
    }
    saveState(state);
  }

  async function slot(p, cfg) {
    const max = cfg.concurrency || 2;
    active[p] = active[p] || 0;
    if (active[p] >= max) await new Promise((res) => (queue[p] = queue[p] || []).push(res));
    active[p]++;
    const gap = (cfg.minIntervalMs || 0) - (now() - (lastStart[p] || 0));
    if (gap > 0) await sleep(gap);
    lastStart[p] = now();
  }
  function release(p) { active[p]--; const q = queue[p]; if (q && q.length) q.shift()(); }

  async function networkFetch(url, headers) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const r = await fetchImpl(url, { headers, signal: ctl ? ctl.signal : undefined });
      const buf = r.status === 304 ? null : Buffer.from(await r.arrayBuffer());
      const h = (k) => (r.headers && typeof r.headers.get === 'function' ? r.headers.get(k) : null);
      return { status: r.status, body: buf, etag: h('etag'), lastModified: h('last-modified'), retryAfter: h('retry-after') };
    } finally { if (t) clearTimeout(t); }
  }

  async function doGet(url, opts) {
    opts = opts || {};
    stats.requests++;
    const p = providerFor(url);
    if (!p) throw new GuardError('UNKNOWN_PROVIDER', 'no provider is configured for ' + url + ' — refusing to fetch an unregistered host');
    const cfg = providers[p];
    const ps = pstat(p); ps.requests++;
    const ttlMs = opts.ttlMs == null ? 6 * 3600 * 1000 : opts.ttlMs;
    const cached = opts.noCache ? null : readCache(url);
    const age = cached ? now() - (cached.meta.fetched_at_ms || 0) : Infinity;
    if (cached && age < ttlMs) {
      stats.cache_hits++; ps.cache_hits++;
      return result({ ok: true, status: cached.meta.status || 200, fromCache: true, stale: false, revalidated: false, provider: p, fetchedAt: new Date(cached.meta.fetched_at_ms).toISOString(), url }, cached.body);
    }
    const staleOr = (code, why) => {
      if (cached && opts.staleIfError !== false) {
        stats.stale_served++;
        return result({ ok: true, status: cached.meta.status || 200, fromCache: true, stale: true, revalidated: false, provider: p, fetchedAt: new Date(cached.meta.fetched_at_ms).toISOString(), url, error: { code, message: why } }, cached.body);
      }
      return result({ ok: false, status: 0, fromCache: false, stale: false, provider: p, url, error: { code, message: why } }, null);
    };
    if (breakerOpen(p)) { stats.refused++; ps.refused++; return staleOr('BREAKER_OPEN', 'the ' + p + ' breaker is open after repeated failures'); }
    const q = quotaCheck(p, cfg);
    if (q) { stats.refused++; ps.refused++; return staleOr('QUOTA', q); }

    const headers = Object.assign({ 'user-agent': 'EdgeDeskSports-engine/1 (+research; github.com/dsrackler17/EdgeDeskSports)' }, opts.headers || {});
    if (cached && cached.meta.etag) headers['if-none-match'] = cached.meta.etag;
    if (cached && cached.meta.last_modified) headers['if-modified-since'] = cached.meta.last_modified;

    const maxAttempts = cfg.paid ? 1 : 1 + retries;
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) { const q2 = quotaCheck(p, cfg); if (q2) { stats.refused++; ps.refused++; return staleOr('QUOTA', q2); } }
      await slot(p, cfg);
      quotaSpend(p);
      stats.network++; ps.network++;
      let r = null, err = null;
      try { r = await networkFetch(url, headers); } catch (e) { err = e; } finally { release(p); }
      if (r && r.status === 304 && cached) {
        stats.revalidated_304++;
        cached.meta.fetched_at_ms = now();
        try { fs.writeFileSync(cachePaths(url).meta, JSON.stringify(cached.meta)); } catch (_) {}
        breakerRecord(p, true);
        return result({ ok: true, status: 200, fromCache: true, stale: false, revalidated: true, provider: p, fetchedAt: new Date(now()).toISOString(), url }, cached.body);
      }
      if (r && r.status >= 200 && r.status < 300) {
        if (!opts.noStore) writeCache(url, r.body, { url, status: r.status, etag: r.etag || null, last_modified: r.lastModified || null, fetched_at_ms: now(), bytes: r.body.length, sha256: sha(r.body) });
        breakerRecord(p, true);
        return result({ ok: true, status: r.status, fromCache: false, stale: false, revalidated: false, provider: p, fetchedAt: new Date(now()).toISOString(), url, sha256: sha(r.body) }, r.body);
      }
      const retryable = !r || r.status === 429 || r.status >= 500;
      last = r ? { code: 'HTTP_' + r.status, message: 'HTTP ' + r.status + ' from ' + p } : { code: 'NETWORK', message: String((err && err.message) || err).slice(0, 200) };
      if (r && r.status === 404) { breakerRecord(p, true); return result({ ok: false, status: 404, fromCache: false, stale: false, provider: p, url, error: last }, null); }
      if (!retryable || attempt === maxAttempts) break;
      stats.retries++;
      const ra = r && r.retryAfter ? Number(r.retryAfter) * 1000 : null;
      const backoff = Math.min(30000, (ra && isFinite(ra) ? ra : 1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250));
      log('[guard] ' + p + ' ' + last.message + ' — retry ' + attempt + ' in ' + backoff + 'ms');
      await sleep(backoff);
    }
    stats.failures++; ps.failures++;
    breakerRecord(p, false);
    return staleOr(last ? last.code : 'FAILED', last ? last.message : 'request failed');
  }

  function get(url, opts) {
    const key = url + '|' + ((opts && opts.ttlMs) || '');
    if (inflight.has(key)) return inflight.get(key);
    const pr = doGet(url, opts).finally(() => inflight.delete(key));
    inflight.set(key, pr);
    return pr;
  }

  return { get, providerFor, stats: () => JSON.parse(JSON.stringify(stats)), state: () => JSON.parse(JSON.stringify(state)) };
}

module.exports = { createClient, GuardError, DEFAULT_PROVIDERS };
